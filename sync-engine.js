/* ============================================================================
   FINPLAN CLOUD SYNC ENGINE  (v1.0)
   ----------------------------------------------------------------------------
   Modular, offline-first sync layer between the FinPlan app and Supabase.

   RULES THIS FILE FOLLOWS:
   - No other part of the app talks to Supabase. Ever. Only this file does.
   - The app's in-memory `DB` object and `saveDB()` / `loadDB()` remain the
     only things the rest of the app (2600+ lines of UI code) ever touches.
   - IndexedDB is the primary local store. localStorage is only read once,
     on first run, to migrate old data in — then it's left alone.
   - Every function here is namespaced under one of five objects so the
     module stays easy to reason about:
       IDB          -> generic local key/value storage (IndexedDB wrapper)
       IdMigration  -> one-time local ID normalization (legacy id -> UUID)
       SupaService  -> the ONLY code that calls the Supabase client
       SyncOutbox   -> the queue of local changes waiting to be uploaded
       SyncEngine   -> the orchestrator: diffing, push, pull, retry, status
   ============================================================================ */

/* ---------------------------------------------------------------------------
   0. CONFIG — paste your Supabase project values here.
   Where to find them: Supabase Dashboard -> your project -> left sidebar
   "Project Settings" (gear icon) -> "API". Copy "Project URL" and the
   "anon public" key (NOT the service_role key — that one must never be
   used in a browser app).
--------------------------------------------------------------------------- */
const SUPABASE_URL = 'https://cbauurxbzlbjfxudbshh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNiYXV1cnhiemxiamZ4dWRic2hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MjE4NjgsImV4cCI6MjEwMjI5Nzg2OH0.IlR3wDhWpyil6vtNm2SCOeojc1bdVjX_c9NxI3j5p90';

/* ---------------------------------------------------------------------------
   1. IDB — tiny promise-based wrapper around IndexedDB.
   One object store ("kv") used as a generic key/value store for:
     'app_state'   -> the full FinPlan DB blob (replaces localStorage)
     'outbox'      -> array of pending upload operations
     'sync_meta'   -> { lastPulledAt: {table: iso_timestamp}, localClock: {...} }
--------------------------------------------------------------------------- */
const IDB = (() => {
  const DB_NAME = 'finplan_idb';
  const STORE = 'kv';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function get(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function set(key, val) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  return { get, set };
})();

/* ---------------------------------------------------------------------------
   2. ID MIGRATION — one-time, fully offline, no network required.
   FinPlan's local `uid()` historically produced short non-UUID strings.
   Supabase's primary keys are UUIDs. Rather than keep a permanent
   translation table forever, we rewrite every existing local record's id
   to a real UUID once, and fix every field anywhere in the app that
   refers to that id. After this runs, local id === cloud id, always.
   Guarded by DB.settings.uuidMigrated so it only ever runs once per device.
--------------------------------------------------------------------------- */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(v) { return typeof v === 'string' && UUID_RE.test(v); }
function newUUID() {
  return (crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    }));
}

const IdMigration = {
  run(db) {
    if (db.settings && db.settings.uuidMigrated) return db;
    const map = {};
    const collect = (arr) => (arr || []).forEach(r => {
      if (r && r.id && !isUUID(r.id)) map[r.id] = newUUID();
    });
    collect(db.accounts); collect(db.categoriesIncome); collect(db.categoriesExpense);
    collect(db.income); collect(db.expense); collect(db.investments);

    const remap = (arr) => (arr || []).forEach(r => { if (r && map[r.id]) r.id = map[r.id]; });
    remap(db.accounts); remap(db.categoriesIncome); remap(db.categoriesExpense);
    remap(db.income); remap(db.expense); remap(db.investments);

    [...(db.income || []), ...(db.expense || [])].forEach(t => {
      if (t.accountId && map[t.accountId]) t.accountId = map[t.accountId];
      if (t.linkedInvestmentId && map[t.linkedInvestmentId]) t.linkedInvestmentId = map[t.linkedInvestmentId];
    });
    (db.investments || []).forEach(inv => {
      if (inv.linkedExpenseId && map[inv.linkedExpenseId]) inv.linkedExpenseId = map[inv.linkedExpenseId];
    });
    if (db.settings && db.settings.defaultAccount && map[db.settings.defaultAccount]) {
      db.settings.defaultAccount = map[db.settings.defaultAccount];
    }
    if (db.settings) db.settings.uuidMigrated = true;
    return db;
  }
};

/* ---------------------------------------------------------------------------
   3. SUPABASE SERVICE — the only module that ever calls Supabase.
   Requires the Supabase JS SDK to be loaded on the page (script tag added
   to index.html). If it hasn't loaded (e.g. first offline install before
   any internet connection ever occurred), every method here fails soft.
--------------------------------------------------------------------------- */
const SupaService = (() => {
  let client = null;
  function getClient() {
    if (client) return client;
    if (typeof window === 'undefined' || !window.supabase) return null;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return client;
  }

  async function getSession() {
    const c = getClient(); if (!c) return null;
    const { data } = await c.auth.getSession();
    return data.session;
  }
  function onAuthStateChange(cb) {
    const c = getClient(); if (!c) return;
    c.auth.onAuthStateChange((event, session) => cb(event, session));
  }
  async function signInWithMagicLink(email) {
    const c = getClient(); if (!c) throw new Error('Supabase not configured');
    return c.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + window.location.pathname } });
  }
  // Email/password signup. If "Confirm email" is enabled in Supabase (default),
  // this automatically sends a verification email — nothing extra to build.
  async function signUpWithPassword(email, password) {
    const c = getClient(); if (!c) throw new Error('Supabase not configured');
    const { data, error } = await c.auth.signUp({
      email, password,
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
    return data;
  }
  async function signInWithPassword(email, password) {
    const c = getClient(); if (!c) throw new Error('Supabase not configured');
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }
  async function signInWithGoogle() {
    const c = getClient(); if (!c) throw new Error('Supabase not configured');
    const { error } = await c.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
    // Browser navigates away to Google here; nothing more to do on this page.
  }
  async function resetPasswordForEmail(email) {
    const c = getClient(); if (!c) throw new Error('Supabase not configured');
    const { error } = await c.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    if (error) throw error;
  }
  async function updatePassword(newPassword) {
    const c = getClient(); if (!c) throw new Error('Supabase not configured');
    const { error } = await c.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }
  async function signOut() {
    const c = getClient(); if (!c) return;
    await c.auth.signOut();
  }

  async function upsert(table, row) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.from(table).upsert(row, { onConflict: 'id' });
    if (error) throw error;
  }
  // Batched upsert — used by flush() so a bulk sync (e.g. years of existing
  // data on first sign-in) is a handful of requests instead of one per row.
  async function upsertBatch(table, rows) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.from(table).upsert(rows, { onConflict: 'id' });
    if (error) throw error;
  }
  async function upsertSettings(row) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.from('settings').upsert(row, { onConflict: 'user_id' });
    if (error) throw error;
  }
  async function softDelete(table, id) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.from(table)
      .update({ is_deleted: true, deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }
  async function softDeleteBatch(table, ids) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.from(table)
      .update({ is_deleted: true, deleted_at: new Date().toISOString() })
      .in('id', ids);
    if (error) throw error;
  }
  // Paginated: a long offline stretch with heavy multi-device edits could mean
  // thousands of changed rows since the last pull. Fetch in pages rather than
  // one unbounded request.
  async function fetchChangedSince(table, userId, sinceIso) {
    const c = getClient(); if (!c) throw new Error('offline');
    const PAGE = 500;
    let all = [], from = 0;
    while (true) {
      let q = c.from(table).select('*').eq('user_id', userId).order('updated_at', { ascending: true });
      q = sinceIso ? q.gt('updated_at', sinceIso) : q;
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }
  async function fetchSettings(userId) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { data, error } = await c.from('settings').select('*').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data;
  }

  return {
    getClient, getSession, onAuthStateChange, signInWithMagicLink, signOut,
    signUpWithPassword, signInWithPassword, signInWithGoogle,
    resetPasswordForEmail, updatePassword,
    upsert, upsertBatch, upsertSettings, softDelete, softDeleteBatch,
    fetchChangedSince, fetchSettings
  };
})();

/* ---------------------------------------------------------------------------
   4. SYNC OUTBOX — persisted queue of pending uploads.
   Each item: { table, op: 'upsert'|'delete', id, row, attempts, addedAt }
   Order matters for foreign keys, so SyncEngine always flushes in table
   priority order: accounts -> categories -> investments -> transactions
   -> settings. This is enforced in SyncEngine.flush(), not here.
--------------------------------------------------------------------------- */
const SyncOutbox = {
  async load() { return (await IDB.get('outbox')) || []; },
  async save(items) { await IDB.set('outbox', items); },
  async push(item) {
    const items = await this.load();
    // De-dupe: if this exact record already has a pending op, replace it
    // (the newest local state wins — no point uploading stale intermediate edits).
    const idx = items.findIndex(i => i.table === item.table && i.id === item.id);
    if (idx > -1) items[idx] = { ...item, attempts: items[idx].attempts };
    else items.push({ ...item, attempts: 0, addedAt: Date.now() });
    await this.save(items);
  },
  async remove(table, id) {
    const items = await this.load();
    await this.save(items.filter(i => !(i.table === table && i.id === id)));
  },
  async bumpAttempts(table, id) {
    const items = await this.load();
    const it = items.find(i => i.table === table && i.id === id);
    if (it) it.attempts = (it.attempts || 0) + 1;
    await this.save(items);
  }
};

/* ---------------------------------------------------------------------------
   5. SYNC ENGINE — the orchestrator.
   Public surface used by the app's UI layer (index.html):
     SyncEngine.init()                 -> call once at boot, after DB is loaded
     SyncEngine.notifyLocalChange(db)  -> call from inside saveDB() every time
     SyncEngine.signIn(email)          -> magic-link sign in
     SyncEngine.signUp(email,pw)       -> email/password account creation (sends verification email)
     SyncEngine.signInPassword(email,pw)
     SyncEngine.signInGoogle()         -> redirects to Google, comes back signed in
     SyncEngine.resetPassword(email)   -> sends password-reset email
     SyncEngine.updatePassword(pw)     -> call while isPasswordRecovery() is true
     SyncEngine.isPasswordRecovery()   -> true right after a reset-password email link is opened
     SyncEngine.clearRecoveryMode()    -> call after updatePassword() succeeds
     SyncEngine.signOut()
     SyncEngine.getStatus()            -> 'signed-out'|'offline'|'syncing'|'synced'|'error'
     SyncEngine.onStatusChange(cb)     -> subscribe a UI callback (status pill)
--------------------------------------------------------------------------- */
const TABLE_ORDER = ['accounts', 'categories', 'investments', 'transactions'];

const SyncEngine = (() => {
  let status = 'signed-out';
  let session = null;
  let recoveryMode = false;  // true while the user is mid password-reset flow
  let lastSnapshot = null;   // last known collections snapshot, for diffing
  let flushTimer = null;
  let pullTimer = null;
  let listeners = [];
  let started = false;

  function setStatus(s) {
    status = s;
    listeners.forEach(cb => { try { cb(s); } catch (e) {} });
  }
  function onStatusChange(cb) { listeners.push(cb); cb(status); }
  function getStatus() { return status; }

  /* ---- Build a flat, diff-friendly snapshot of the current DB ---- */
  function snapshotOf(db) {
    return {
      accounts: db.accounts || [],
      categories: [
        ...(db.categoriesIncome || []).map(c => ({ ...c, kind: 'income' })),
        ...(db.categoriesExpense || []).map(c => ({ ...c, kind: 'expense' }))
      ],
      investments: db.investments || [],
      transactions: [
        ...(db.income || []).map(t => ({ ...t, type: 'income' })),
        ...(db.expense || []).map(t => ({ ...t, type: 'expense' }))
      ],
      settings: db.settings || {}
    };
  }

  /* ---- Row builders: local record shape -> Supabase row shape ---- */
  function rowUserId() { return session && session.user && session.user.id; }
  // Local transactions store the category as a NAME string, but the remote
  // schema has a proper category_id FK. Categories always sync before
  // transactions (TABLE_ORDER), and ids are unified UUIDs post-migration, so
  // we resolve the real id here instead of leaving the column empty.
  function resolveCategoryId(db, type, categoryName) {
    const list = type === 'income' ? db.categoriesIncome : db.categoriesExpense;
    const match = (list || []).find(c => c.name === categoryName);
    return match ? match.id : null;
  }
  function resolveCategoryName(db, kind, categoryId) {
    const list = kind === 'income' ? db.categoriesIncome : db.categoriesExpense;
    const match = (list || []).find(c => c.id === categoryId);
    return match ? match.name : null;
  }

  function toAccountRow(a) {
    return {
      id: a.id, user_id: rowUserId(), name: a.name, type: a.type, icon: a.icon,
      color: a.color, opening_balance: a.openingBalance || 0
    };
  }
  function toCategoryRow(c) {
    return {
      id: c.id, user_id: rowUserId(), kind: c.kind, name: c.name,
      icon: c.icon, color: c.color, locked: !!c.locked
    };
  }
  function toInvestmentRow(inv) {
    return {
      id: inv.id, user_id: rowUserId(), name: inv.name, category: inv.category,
      purchase_date: inv.purchaseDate, purchase_price: inv.purchasePrice || null,
      quantity: inv.quantity || null, invested_amount: inv.investedAmount || 0,
      current_value: inv.currentValue || 0, notes: inv.notes || null,
      history: inv.history || [], linked_expense_id: inv.linkedExpenseId || null,
      txn_id: inv.txnId || null, closed: !!inv.closed
    };
  }
  function toTransactionRow(t, db) {
    return {
      id: t.id, user_id: rowUserId(), type: t.type, date: t.date, amount: t.amount,
      account_id: t.accountId, category_id: resolveCategoryId(db, t.type, t.category),
      notes: t.notes || null,
      tags: t.tags || [], location: t.location || null, attachment: t.attachment || null,
      credit: t.credit || null, loan: t.loan || null, reminder: t.reminder || null,
      linked_investment_id: t.linkedInvestmentId || null, realized_pl: t.realizedPL ?? null,
      txn_id: t.txnId || null
    };
  }
  function toSettingsRow(s) {
    return {
      user_id: rowUserId(), currency: s.currency, theme: s.theme, accent: s.accent,
      date_format: s.dateFormat, default_account_id: s.defaultAccount || null,
      notif_enabled: !!s.notifEnabled, notified_log: s.notifiedLog || {}
    };
  }

  /* ---- Diff current DB against last snapshot, queue outbox ops ---- */
  async function notifyLocalChange(db) {
    if (!started) return; // engine not initialized yet (e.g. very first loadDB call)
    const snap = snapshotOf(db);
    const prev = lastSnapshot;
    lastSnapshot = snap;
    if (!prev) return; // nothing to diff against on the very first pass

    for (const table of TABLE_ORDER) {
      const prevArr = prev[table] || [];
      const newArr = snap[table] || [];
      const prevMap = new Map(prevArr.map(r => [r.id, r]));
      const newMap = new Map(newArr.map(r => [r.id, r]));

      for (const [id, rec] of newMap) {
        const old = prevMap.get(id);
        if (!old || JSON.stringify(old) !== JSON.stringify(rec)) {
          const row = table === 'accounts' ? toAccountRow(rec)
            : table === 'categories' ? toCategoryRow(rec)
            : table === 'investments' ? toInvestmentRow(rec)
            : toTransactionRow(rec, db);
          await SyncOutbox.push({ table, op: 'upsert', id, row });
        }
      }
      for (const [id] of prevMap) {
        if (!newMap.has(id)) await SyncOutbox.push({ table, op: 'delete', id, row: null });
      }
    }
    // settings is a singleton row, diffed separately
    if (!prev.settings || JSON.stringify(prev.settings) !== JSON.stringify(snap.settings)) {
      await SyncOutbox.push({ table: 'settings', op: 'upsert', id: 'singleton', row: toSettingsRow(snap.settings) });
    }

    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 1500); // debounce rapid edits
  }

  const MAX_ATTEMPTS = 10; // stop retrying a permanently-failing item (e.g. a
  // duplicate-name constraint violation) after this many tries, instead of
  // hammering the API forever every retry cycle.

  /* ---- Push queued ops to Supabase, table-by-table, batched, with retry ---- */
  async function flush() {
    if (!navigator.onLine) { setStatus('offline'); return; }
    if (!session) { setStatus('signed-out'); return; }
    let items = await SyncOutbox.load();
    if (items.length === 0) { setStatus('synced'); return; }
    setStatus('syncing');

    // Drop anything that's failed too many times in a row so it doesn't
    // retry forever — surface it as an error instead of silently looping.
    const dead = items.filter(i => (i.attempts || 0) >= MAX_ATTEMPTS);
    if (dead.length) {
      items = items.filter(i => (i.attempts || 0) < MAX_ATTEMPTS);
      await SyncOutbox.save(items.concat(dead)); // keep them queued but excluded from this pass
    }

    const order = [...TABLE_ORDER, 'settings'];
    let anyFailed = dead.length > 0;
    for (const table of order) {
      const batch = items.filter(i => i.table === table);
      if (!batch.length) continue;

      if (table === 'settings') {
        for (const item of batch) {
          try { await SupaService.upsertSettings(item.row); await SyncOutbox.remove(table, item.id); }
          catch (e) { anyFailed = true; await SyncOutbox.bumpAttempts(table, item.id); }
        }
        continue;
      }

      // Batch upserts and batch deletes each into a single request per table.
      const upserts = batch.filter(i => i.op === 'upsert');
      const deletes = batch.filter(i => i.op === 'delete');
      if (upserts.length) {
        try {
          await SupaService.upsertBatch(table, upserts.map(i => i.row));
          for (const i of upserts) await SyncOutbox.remove(table, i.id);
        } catch (e) {
          anyFailed = true;
          for (const i of upserts) await SyncOutbox.bumpAttempts(table, i.id);
          // Common transient case: an investment references a transaction (or
          // vice versa) that hasn't uploaded yet in this same cycle. Leaving
          // it queued means the next flush cycle resolves it once the sibling
          // record has synced.
        }
      }
      if (deletes.length) {
        try {
          await SupaService.softDeleteBatch(table, deletes.map(i => i.id));
          for (const i of deletes) await SyncOutbox.remove(table, i.id);
        } catch (e) {
          anyFailed = true;
          for (const i of deletes) await SyncOutbox.bumpAttempts(table, i.id);
        }
      }
    }
    setStatus(anyFailed ? (dead.length ? 'error' : 'syncing') : 'synced');
    if (anyFailed && !dead.length) flushTimer = setTimeout(flush, 8000); // backoff retry
  }

  /* ---- Pull remote changes down and merge into local DB ---- */
  async function pullRemoteChanges(applyToDb, rerender) {
    if (!navigator.onLine || !session) return;
    const uid = session.user.id;
    const meta = (await IDB.get('sync_meta')) || { lastPulledAt: {} };
    let changed = false;

    try {
      // Records with a pending local edit still in the outbox must not be
      // clobbered by an incoming (older, by definition) remote version —
      // our local edit is already queued to overwrite it. Skip merging
      // those specific records this cycle; they'll reconcile once our own
      // push lands and the next pull sees the newer server state.
      const pendingIds = new Set((await SyncOutbox.load()).map(i => i.table + '::' + i.id));

      for (const table of TABLE_ORDER) {
        const since = meta.lastPulledAt[table];
        const rows = await SupaService.fetchChangedSince(table, uid, since);
        if (rows.length) { mergeRemoteRows(table, rows, applyToDb, pendingIds); changed = true; }
        meta.lastPulledAt[table] = new Date().toISOString();
      }
      const settingsRow = await SupaService.fetchSettings(uid);
      if (settingsRow && !pendingIds.has('settings::singleton')) {
        mergeRemoteSettings(settingsRow, applyToDb); changed = true;
      }
      await IDB.set('sync_meta', meta);
      if (changed) { lastSnapshot = snapshotOf(applyToDb.get()); rerender && rerender(); }
      setStatus('synced');
    } catch (e) {
      setStatus('error');
    }
  }

  function mergeRemoteRows(table, rows, applyToDb, pendingIds) {
    const db = applyToDb.get();
    rows.forEach(r => {
      if (pendingIds && pendingIds.has(table + '::' + r.id)) return; // local edit pending, don't overwrite
      if (table === 'accounts') mergeInto(db.accounts, fromAccountRow(r), r);
      if (table === 'investments') mergeInto(db.investments, fromInvestmentRow(r), r);
      if (table === 'transactions') {
        const arr = r.type === 'income' ? db.income : db.expense;
        mergeInto(arr, fromTransactionRow(r, db), r);
      }
      if (table === 'categories') {
        const arr = r.kind === 'income' ? db.categoriesIncome : db.categoriesExpense;
        mergeInto(arr, fromCategoryRow(r), r);
      }
    });
    applyToDb.set(db);
  }
  function mergeInto(arr, localShapedRecord, remoteRow) {
    const idx = arr.findIndex(x => x.id === remoteRow.id);
    if (remoteRow.is_deleted) { if (idx > -1) arr.splice(idx, 1); return; }
    if (idx > -1) arr[idx] = localShapedRecord; else arr.push(localShapedRecord);
  }
  function mergeRemoteSettings(row, applyToDb) {
    if (row.is_deleted) return;
    const db = applyToDb.get();
    db.settings = {
      ...db.settings, currency: row.currency, theme: row.theme, accent: row.accent,
      dateFormat: row.date_format, defaultAccount: row.default_account_id || db.settings.defaultAccount,
      notifEnabled: row.notif_enabled, notifiedLog: row.notified_log || db.settings.notifiedLog
    };
    applyToDb.set(db);
  }

  function fromAccountRow(r) {
    return { id: r.id, name: r.name, type: r.type, icon: r.icon, color: r.color, openingBalance: r.opening_balance };
  }
  function fromCategoryRow(r) {
    return { id: r.id, name: r.name, icon: r.icon, color: r.color, locked: r.locked };
  }
  function fromInvestmentRow(r) {
    return {
      id: r.id, name: r.name, category: r.category, purchaseDate: r.purchase_date,
      purchasePrice: r.purchase_price, quantity: r.quantity, investedAmount: r.invested_amount,
      currentValue: r.current_value, notes: r.notes, history: r.history || [],
      linkedExpenseId: r.linked_expense_id, txnId: r.txn_id, closed: r.closed
    };
  }
  function fromTransactionRow(r, db) {
    return {
      id: r.id, date: r.date, amount: r.amount, accountId: r.account_id,
      category: resolveCategoryName(db, r.type, r.category_id) || '',
      notes: r.notes, tags: r.tags || [], location: r.location, attachment: r.attachment,
      credit: r.credit, loan: r.loan, reminder: r.reminder, linkedInvestmentId: r.linked_investment_id,
      realizedPL: r.realized_pl, txnId: r.txn_id
    };
  }

  /* ---- Lifecycle ---- */
  async function init(applyToDb, rerender) {
    started = true;
    lastSnapshot = snapshotOf(applyToDb.get());

    // Automatic login: the Supabase client persists its session in the browser
    // (persistSession:true, configured in getClient()) and refreshes it silently
    // (autoRefreshToken:true) — so a valid session is simply already here on load,
    // with no action needed from the user.
    session = await SupaService.getSession();
    setStatus(session ? (navigator.onLine ? 'syncing' : 'offline') : 'signed-out');

    SupaService.onAuthStateChange(async (event, s) => {
      // Fired when the user opens a "reset password" email link. Show the
      // "set a new password" form instead of treating this as a normal sign-in.
      if (event === 'PASSWORD_RECOVERY') {
        recoveryMode = true;
        rerender && rerender();
        return;
      }
      const wasSignedOut = !session;
      session = s;
      if (!s) {
        // Automatic logout: fires whenever Supabase invalidates the session
        // (explicit sign-out, or a refresh token that's expired/been revoked).
        recoveryMode = false;
        setStatus('signed-out');
        rerender && rerender();
        return;
      }
      if (wasSignedOut) {
        // First sign-in on this device: push everything local up, then pull.
        lastSnapshot = null;
        await notifyLocalChange(applyToDb.get());
        await flush();
      }
      await pullRemoteChanges(applyToDb, rerender);
      rerender && rerender(); // reflect the now-signed-in state immediately (e.g. Settings screen)
    });

    window.addEventListener('online', async () => {
      if (session) { await flush(); await pullRemoteChanges(applyToDb, rerender); }
      else setStatus('signed-out');
    });
    window.addEventListener('offline', () => setStatus('offline'));

    if (session) {
      // Resume any changes still sitting in the outbox from a previous
      // session (e.g. the app was closed before they finished uploading)
      // instead of waiting for the user's next edit to trigger a flush.
      const pending = await SyncOutbox.load();
      if (pending.length && navigator.onLine) await flush();
      await pullRemoteChanges(applyToDb, rerender);
    }

    if (pullTimer) clearInterval(pullTimer);
    pullTimer = setInterval(() => {
      if (session && navigator.onLine) pullRemoteChanges(applyToDb, rerender);
    }, 30000);
  }

  async function signIn(email) { return SupaService.signInWithMagicLink(email); }
  async function signUp(email, password) { return SupaService.signUpWithPassword(email, password); }
  async function signInPassword(email, password) { return SupaService.signInWithPassword(email, password); }
  async function signInGoogle() { return SupaService.signInWithGoogle(); }
  async function resetPassword(email) { return SupaService.resetPasswordForEmail(email); }
  async function updatePassword(pw) { return SupaService.updatePassword(pw); }
  function isPasswordRecovery() { return recoveryMode; }
  function clearRecoveryMode() { recoveryMode = false; }
  async function signOut() { await SupaService.signOut(); session = null; recoveryMode = false; setStatus('signed-out'); }
  function isSignedIn() { return !!session; }
  function currentEmail() { return session && session.user && session.user.email; }

  return {
    init, notifyLocalChange, signIn, signUp, signInPassword, signInGoogle,
    resetPassword, updatePassword, isPasswordRecovery, clearRecoveryMode,
    signOut, isSignedIn, currentEmail, getStatus, onStatusChange
  };
})();
