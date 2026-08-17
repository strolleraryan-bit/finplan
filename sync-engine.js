/* ============================================================================
   FINPLAN SYNC ENGINE  (v3.0 — FINAL, all fixes consolidated)
   ----------------------------------------------------------------------------
   Design principles:
   1. All record IDs MUST be UUIDs. Legacy non-UUID ids are auto-migrated once
      on load, and any row builder silently skips a record that still isn't
      a valid UUID (defensive — should never happen after migration).
   2. Every save (saveDB -> notifyLocalChange) tries to push immediately if
      online. If offline, the change stays queued in an outbox and an
      offline banner is shown; nothing is lost.
   3. Pull is always a FULL pull (fetch everything from Supabase and replace
      local state) — never incremental. This guarantees no record is ever
      missed due to clock/timestamp issues.
   4. On sign-in: local outbox + local snapshot are wiped, then a full pull
      happens. Server always wins on login.
   5. On sign-out: all local data is wiped so no stale data leaks to the
      next login (same device, different account, or re-login).
   ============================================================================ */

const SUPABASE_URL = 'https://cbauurxbzlbjfxudbshh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNiYXV1cnhiemxiamZ4dWRic2hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MjE4NjgsImV4cCI6MjEwMjI5Nzg2OH0.IlR3wDhWpyil6vtNm2SCOeojc1bdVjX_c9NxI3j5p90';

const SYNC_STATE_KEY = 'app_state';
const OUTBOX_KEY = 'outbox';
const PULL_INTERVAL_MS = 20000; // 20s

/* ---------------------------------------------------------------------------
   1. IDB — tiny IndexedDB key/value wrapper (matches what index.html expects
      as the global `IDB` — get/set)
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
      r.onsuccess = () => resolve(r.result ?? null);
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
window.IDB = IDB;

// Exposed for index.html's loadDB(), which calls IdMigration.run(db)
// before the sync engine has even initialized.
window.IdMigration = { run: migrateLegacyIds };

/* ---------------------------------------------------------------------------
   2. UUID helpers
--------------------------------------------------------------------------- */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(v) { return typeof v === 'string' && UUID_RE.test(v); }
function newUUID() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

/* ---------------------------------------------------------------------------
   3. One-time legacy-ID migration (runs on every boot; idempotent because
      it only touches ids that are still non-UUID)
--------------------------------------------------------------------------- */
function migrateLegacyIds(db) {
  const map = {};
  const collect = (arr) => (arr || []).forEach(r => {
    if (r && r.id && !isUUID(r.id)) map[r.id] = newUUID();
  });
  collect(db.accounts); collect(db.categoriesIncome); collect(db.categoriesExpense);
  collect(db.income); collect(db.expense); collect(db.investments);

  if (Object.keys(map).length === 0) return db; // nothing to do

  const remap = (arr) => (arr || []).forEach(r => { if (r && r.id && map[r.id]) r.id = map[r.id]; });
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
  return db;
}

/* ---------------------------------------------------------------------------
   4. Offline banner
--------------------------------------------------------------------------- */
const OfflineBanner = (() => {
  let el = null;
  function ensure() {
    if (el) return;
    el = document.createElement('div');
    el.id = 'finplan-offline-banner';
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
      'background:#c0392b', 'color:#fff', 'text-align:center',
      'padding:10px 16px', 'font-size:13px', 'font-weight:600',
      'display:none', 'align-items:center', 'justify-content:center', 'gap:8px'
    ].join(';');
    el.textContent = '⚠️  Internet nahi hai — data locally save ho raha hai, connection aate hi sync ho jayega';
    document.body.prepend(el);
  }
  function show() { ensure(); el.style.display = 'flex'; }
  function hide() { if (el) el.style.display = 'none'; }
  return { show, hide };
})();

/* ---------------------------------------------------------------------------
   5. Supabase service layer
--------------------------------------------------------------------------- */
const SupaService = (() => {
  let _client = null;
  function getClient() {
    if (_client) return _client;
    if (typeof supabase === 'undefined') return null;
    _client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return _client;
  }
  async function getSession() {
    const c = getClient(); if (!c) return null;
    const { data } = await c.auth.getSession();
    return data && data.session ? data.session : null;
  }
  function onAuthStateChange(cb) {
    const c = getClient(); if (!c) return;
    c.auth.onAuthStateChange(cb);
  }
  async function signInWithGoogle() {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href }
    });
    if (error) throw error;
  }
  async function signInPassword(email, password) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }
  async function signUp(email, password) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.auth.signUp({ email, password });
    if (error) throw error;
  }
  async function resetPassword(email) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
    if (error) throw error;
  }
  async function updatePassword(pw) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.auth.updateUser({ password: pw });
    if (error) throw error;
  }
  async function signOut() {
    const c = getClient(); if (!c) return;
    try { await c.auth.signOut(); } catch (e) { /* session already invalid — ignore 403 */ }
  }
  async function upsert(table, rows) {
    if (!rows.length) return;
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.from(table).upsert(rows, { onConflict: 'id' });
    if (error) throw error;
  }
  async function upsertSettings(row) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.from('settings').upsert([row], { onConflict: 'user_id' });
    if (error) throw error;
  }
  async function softDelete(table, id) {
    const c = getClient(); if (!c) throw new Error('offline');
    const { error } = await c.from(table).update({
      is_deleted: true, deleted_at: new Date().toISOString()
    }).eq('id', id);
    if (error) throw error;
  }
  // Always fetches ALL rows for the table (full pull, no incremental filter).
  // Transactions are ordered date desc, created_at desc so that same-day
  // entries come back in true chronological (most-recent-first) order —
  // needed because record ids are random UUIDs and can't be used to infer
  // creation order the way the old timestamp-based ids could.
  async function fetchAll(table, userId) {
    const c = getClient(); if (!c) throw new Error('offline');
    const PAGE = 1000;
    let all = [], from = 0;
    while (true) {
      let q = c.from(table)
        .select('*')
        .eq('user_id', userId)
        .eq('is_deleted', false);
      q = (table === 'transactions')
        ? q.order('date', { ascending: false }).order('created_at', { ascending: false })
        : q.order('created_at', { ascending: true });
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
    getClient, getSession, onAuthStateChange,
    signInWithGoogle, signInPassword, signUp, resetPassword, updatePassword, signOut,
    upsert, upsertSettings, softDelete, fetchAll, fetchSettings
  };
})();

/* ---------------------------------------------------------------------------
   6. Row builders (app object -> Supabase row). Every builder returns null
      if the record's id (or a required FK) is not a valid UUID, so it is
      silently skipped rather than sent and rejected by Postgres.
--------------------------------------------------------------------------- */
function toAccountRow(a, uid) {
  if (!isUUID(a.id)) return null;
  return {
    id: a.id, user_id: uid, name: a.name || '', type: a.type || 'bank',
    icon: a.icon || null, color: a.color || null,
    opening_balance: a.openingBalance || 0, is_deleted: false, deleted_at: null
  };
}
function toCategoryRow(c, uid) {
  if (!isUUID(c.id)) return null;
  return {
    id: c.id, user_id: uid, kind: c.kind, name: c.name || '',
    icon: c.icon || null, color: c.color || null, locked: !!c.locked,
    is_deleted: false, deleted_at: null
  };
}
// Coerces a value into a safe number for a numeric Postgres column, or
// null if it's empty/invalid. Prevents '' (empty string) — which the app
// can leave in fields that have no dedicated input, e.g. investment
// purchase price — from being sent to Supabase, which rejects '' for a
// numeric column and aborts the ENTIRE push (accounts/categories/investments/
// transactions/settings all failed to sync as a result, not just investments).
function toNumOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toInvestmentRow(inv, uid) {
  if (!isUUID(inv.id)) return null;
  return {
    id: inv.id, user_id: uid, name: inv.name || '', category: inv.category || '',
    purchase_date: inv.purchaseDate || null, purchase_price: toNumOrNull(inv.purchasePrice),
    quantity: toNumOrNull(inv.quantity), invested_amount: inv.investedAmount || 0,
    current_value: inv.currentValue || 0, notes: inv.notes || null,
    history: inv.history || [],
    linked_expense_id: (inv.linkedExpenseId && isUUID(inv.linkedExpenseId)) ? inv.linkedExpenseId : null,
    txn_id: inv.txnId || null, closed: !!inv.closed,
    is_deleted: false, deleted_at: null
  };
}
function toTransactionRow(t, uid, db) {
  if (!isUUID(t.id)) return null;
  let catId = null;
  const cats = t.type === 'income' ? (db.categoriesIncome || []) : (db.categoriesExpense || []);
  const found = cats.find(c => c.name === t.category);
  if (found && isUUID(found.id)) catId = found.id;
  return {
    id: t.id, user_id: uid, type: t.type, date: t.date, amount: t.amount,
    account_id: (t.accountId && isUUID(t.accountId)) ? t.accountId : null,
    category_id: catId,
    notes: t.notes || null, tags: t.tags || [], location: t.location || null,
    attachment: t.attachment || null, credit: t.credit || null, loan: t.loan || null,
    reminder: t.reminder || null,
    linked_investment_id: (t.linkedInvestmentId && isUUID(t.linkedInvestmentId)) ? t.linkedInvestmentId : null,
    linked_credit_id: (t.linkedCreditId && isUUID(t.linkedCreditId)) ? t.linkedCreditId : null,
    transfer_pair_id: (t.transferPairId && isUUID(t.transferPairId)) ? t.transferPairId : null,
    realized_pl: t.realizedPL ?? null, txn_id: t.txnId || null,
    is_deleted: false, deleted_at: null
  };
}
function toSettingsRow(s, uid, notifiedLog) {
  return {
    user_id: uid, currency: s.currency || 'INR', theme: s.theme || 'dark',
    accent: s.accent || null, date_format: s.dateFormat || 'DD/MM/YYYY',
    default_account_id: (s.defaultAccount && isUUID(s.defaultAccount)) ? s.defaultAccount : null,
    notif_enabled: !!s.notifEnabled, notified_log: notifiedLog || {}
  };
}

/* ---------------------------------------------------------------------------
   7. Reverse mappers (Supabase row -> app object), used when pulling
--------------------------------------------------------------------------- */
function fromAccountRow(a) {
  return { id: a.id, name: a.name, type: a.type, icon: a.icon, color: a.color, openingBalance: Number(a.opening_balance) || 0 };
}
function fromCategoryRow(c) {
  return { id: c.id, name: c.name, icon: c.icon, color: c.color, locked: !!c.locked };
}
function fromInvestmentRow(i) {
  return {
    id: i.id, name: i.name, category: i.category, purchaseDate: i.purchase_date,
    purchasePrice: i.purchase_price, quantity: i.quantity,
    investedAmount: Number(i.invested_amount) || 0, currentValue: Number(i.current_value) || 0,
    notes: i.notes, history: i.history || [], linkedExpenseId: i.linked_expense_id,
    txnId: i.txn_id, closed: !!i.closed
  };
}
function fromTransactionRow(t, accountsById, categoriesById) {
  const acc = accountsById[t.account_id];
  const cat = categoriesById[t.category_id];
  return {
    id: t.id, date: t.date, amount: Number(t.amount) || 0,
    accountId: t.account_id || null, accountName: acc ? acc.name : '',
    category: cat ? cat.name : '', categoryId: t.category_id || null,
    notes: t.notes, tags: t.tags || [], location: t.location,
    attachment: t.attachment, credit: t.credit, loan: t.loan,
    reminder: t.reminder, linkedInvestmentId: t.linked_investment_id,
    linkedCreditId: t.linked_credit_id || null,
    transferPairId: t.transfer_pair_id || null,
    realizedPL: t.realized_pl, txnId: t.txn_id,
    createdAt: t.created_at || null
  };
}

/* ---------------------------------------------------------------------------
   8. Outbox — persisted queue of pending pushes (used only while offline;
      the moment we're back online it's flushed and cleared)
--------------------------------------------------------------------------- */
const Outbox = {
  async load() { return (await IDB.get(OUTBOX_KEY)) || []; },
  async save(items) { await IDB.set(OUTBOX_KEY, items); },
  async clear() { await IDB.set(OUTBOX_KEY, []); },
  async push(item) {
    const items = await Outbox.load();
    items.push(item);
    await Outbox.save(items);
  }
};

/* ---------------------------------------------------------------------------
   9. SyncEngine — main orchestrator, exposes the exact API index.html uses
--------------------------------------------------------------------------- */
const SyncEngine = (() => {
  let uid = null;
  let session = null;
  let status = 'signed-out'; // 'signed-out' | 'offline' | 'syncing' | 'synced' | 'error'
  let statusListeners = [];
  let recoveryMode = false;
  let applyToDbRef = null;
  let rerenderRef = null;
  let pullTimer = null;
  let pushInFlight = false;
  let pulledOnce = false; // guards against pushing pre-pull default/seed data
  // Tracks the set of ids known to exist (locally + server) after the last
  // successful sync, per table. Used to detect deletions: any id present in
  // knownIds but missing from the current local DB was deleted locally and
  // must be soft-deleted on the server too, or it will reappear on next pull.
  let knownIds = { accounts: new Set(), categories: new Set(), investments: new Set(), transactions: new Set() };

  function setStatus(s) {
    status = s;
    statusListeners.forEach(fn => { try { fn(s); } catch (e) {} });
  }

  /* ---- PUSH: build rows for every table from current app DB and upsert ---- */
  async function pushAll(db) {
    if (!uid) return;
    if (!navigator.onLine) { OfflineBanner.show(); setStatus('offline'); return; }
    if (pushInFlight) return;
    pushInFlight = true;
    OfflineBanner.hide();
    setStatus('syncing');
    try {
      const accRows = (db.accounts || []).map(a => toAccountRow(a, uid)).filter(Boolean);
      await SupaService.upsert('accounts', accRows);

      const catRows = [
        ...(db.categoriesIncome || []).map(c => toCategoryRow({ ...c, kind: 'income' }, uid)),
        ...(db.categoriesExpense || []).map(c => toCategoryRow({ ...c, kind: 'expense' }, uid))
      ].filter(Boolean);
      await SupaService.upsert('categories', catRows);

      const invRows = (db.investments || []).map(i => toInvestmentRow(i, uid)).filter(Boolean);
      await SupaService.upsert('investments', invRows);

      const txnRows = [
        ...(db.income || []).map(t => toTransactionRow({ ...t, type: 'income' }, uid, db)),
        ...(db.expense || []).map(t => toTransactionRow({ ...t, type: 'expense' }, uid, db))
      ].filter(Boolean);
      await SupaService.upsert('transactions', txnRows);

      if (db.settings) await SupaService.upsertSettings(toSettingsRow(db.settings, uid, db.notifiedLog));

      // ---- Detect and propagate deletions ----
      // Anything that was in knownIds[table] from the last sync but is no
      // longer present locally was deleted by the user; soft-delete it on
      // the server so it doesn't get resurrected by the next pull.
      const currentIds = {
        accounts: new Set(accRows.map(r => r.id)),
        categories: new Set(catRows.map(r => r.id)),
        investments: new Set(invRows.map(r => r.id)),
        transactions: new Set(txnRows.map(r => r.id))
      };
      for (const table of ['accounts', 'categories', 'investments', 'transactions']) {
        for (const oldId of knownIds[table]) {
          if (!currentIds[table].has(oldId)) {
            try { await SupaService.softDelete(table, oldId); }
            catch (delErr) { console.error('[SyncEngine] softDelete failed:', table, oldId, delErr); }
          }
        }
        knownIds[table] = currentIds[table];
      }

      await Outbox.clear();
      setStatus('synced');
    } catch (e) {
      console.error('[SyncEngine] push failed:', e);
      if (e && e.code === '23505') {
        // Unique-constraint clash (e.g. a category with the same name
        // already exists server-side under a different id). Re-pull to
        // adopt the server's version of that record instead of retrying
        // the same losing insert forever.
        pulledOnce = false;
        knownIds = { accounts: new Set(), categories: new Set(), investments: new Set(), transactions: new Set() };
        await pullAll();
      } else {
        // Keep a marker in outbox so we retry once back online / next save
        await Outbox.save([{ ts: Date.now() }]);
        setStatus('error');
      }
    } finally {
      pushInFlight = false;
    }
  }

  /* ---- PULL: fetch everything from Supabase and replace local state ---- */
  async function pullAll() {
    if (!uid || !applyToDbRef) return;
    if (!navigator.onLine) { setStatus('offline'); OfflineBanner.show(); return; }
    setStatus('syncing');
    try {
      const [accounts, categories, investments, transactions, settingsRow] = await Promise.all([
        SupaService.fetchAll('accounts', uid),
        SupaService.fetchAll('categories', uid),
        SupaService.fetchAll('investments', uid),
        SupaService.fetchAll('transactions', uid),
        SupaService.fetchSettings(uid)
      ]);

      const db = applyToDbRef.get();

      // Brand-new account scenario: Supabase genuinely has nothing yet for
      // this user (first-ever login, or a fresh signup after the old
      // account was deleted). In that case do NOT wipe the local
      // default-seeded accounts/categories (Cash, Bank, default category
      // list) that loadDB() already created — instead push them up to
      // become the user's initial server-side data. Overwriting local with
      // an empty pull here was the bug: it deleted the local defaults
      // before they ever got a chance to sync, leaving both local and
      // server empty and nothing selectable in the UI.
      const serverIsEmpty = accounts.length === 0 && categories.length === 0 &&
        investments.length === 0 && transactions.length === 0 && !settingsRow;
      if (serverIsEmpty && !pulledOnce) {
        pulledOnce = true;
        knownIds = { accounts: new Set(), categories: new Set(), investments: new Set(), transactions: new Set() };
        setStatus('synced');
        OfflineBanner.hide();
        // A genuinely fresh local defaultDB() has account/category ids
        // generated by the app's own local uid() helper (legacy, non-UUID
        // format) — index.html's own fresh-install fallback path returns
        // this default data WITHOUT ever running IdMigration on it. Every
        // row builder silently drops non-UUID ids, so pushing straight
        // away here would push nothing at all. Migrate ids first.
        const migrated = migrateLegacyIds(db);
        applyToDbRef.set(migrated);
        await IDB.set(SYNC_STATE_KEY, migrated);
        // Seed the server with whatever local defaults/data currently exist.
        await pushAll(migrated);
        rerenderRef && rerenderRef();
        return;
      }

      db.accounts = accounts.map(fromAccountRow);

      const accountsById = {};
      db.accounts.forEach(a => { accountsById[a.id] = a; });

      db.categoriesIncome = categories.filter(c => c.kind === 'income').map(fromCategoryRow);
      db.categoriesExpense = categories.filter(c => c.kind === 'expense').map(fromCategoryRow);

      const categoriesById = {};
      categories.forEach(c => { categoriesById[c.id] = c; });

      db.investments = investments.map(fromInvestmentRow);

      const incomeRows = transactions.filter(t => t.type === 'income');
      const expenseRows = transactions.filter(t => t.type === 'expense');
      db.income = incomeRows.map(t => fromTransactionRow(t, accountsById, categoriesById));
      db.expense = expenseRows.map(t => fromTransactionRow(t, accountsById, categoriesById));

      if (settingsRow) {
        db.settings = {
          ...db.settings,
          currency: settingsRow.currency || db.settings.currency,
          theme: settingsRow.theme || db.settings.theme,
          accent: settingsRow.accent,
          dateFormat: settingsRow.date_format || db.settings.dateFormat,
          defaultAccount: settingsRow.default_account_id,
          notifEnabled: !!settingsRow.notif_enabled
        };
        // notifiedLog lives at db.notifiedLog (top-level), not db.settings.notifiedLog
        db.notifiedLog = settingsRow.notified_log || db.notifiedLog || {};
      }

      // Seed knownIds from what the server just gave us, so that any local
      // deletion made AFTER this point is correctly detected as "missing"
      // on the very next push.
      knownIds.accounts = new Set(accounts.map(a => a.id));
      knownIds.categories = new Set(categories.map(c => c.id));
      knownIds.investments = new Set(investments.map(i => i.id));
      knownIds.transactions = new Set(transactions.map(t => t.id));

      applyToDbRef.set(db);
      await IDB.set(SYNC_STATE_KEY, db);
      pulledOnce = true;
      setStatus('synced');
      OfflineBanner.hide();
      rerenderRef && rerenderRef();
    } catch (e) {
      console.error('[SyncEngine] pull failed:', e);
      setStatus('error');
    }
  }

  /* ---- Called on every local save ---- */
  async function notifyLocalChange(db) {
    if (!uid) return; // not signed in, nothing to sync
    db = migrateLegacyIds(db);
    if (!pulledOnce) {
      // First pull hasn't completed yet — pushing now would send fresh
      // default/seed data (new ids) that can collide with same-named
      // records already on the server. Local save already happened via
      // saveDBSilent/saveDB; the real push happens once pull finishes.
      return;
    }
    if (!navigator.onLine) {
      OfflineBanner.show();
      setStatus('offline');
      await Outbox.save([{ ts: Date.now() }]); // mark that a push is owed
      return;
    }
    await pushAll(db);
  }

  /* ---- Online/offline listeners ---- */
  function setupNetworkListeners() {
    window.addEventListener('online', async () => {
      OfflineBanner.hide();
      if (!uid || !applyToDbRef) return;
      const pending = await Outbox.load();
      if (pending.length) {
        const migrated = migrateLegacyIds(applyToDbRef.get());
        applyToDbRef.set(migrated);
        await pushAll(migrated);
      }
      await pullAll();
    });
    window.addEventListener('offline', () => {
      setStatus('offline');
      OfflineBanner.show();
    });
  }

  /* ---- Init ---- */
  async function init(applyToDb, rerender) {
    applyToDbRef = applyToDb;
    rerenderRef = rerender;

    if (!navigator.onLine) { OfflineBanner.show(); setStatus('offline'); }
    setupNetworkListeners();

    SupaService.onAuthStateChange(async (event, s) => {
      const wasSignedIn = !!uid;
      session = s;
      uid = s && s.user ? s.user.id : null;

      if (event === 'PASSWORD_RECOVERY') { recoveryMode = true; rerenderRef && rerenderRef(); return; }

      if (!uid) {
        // Signed out — either explicitly (user tapped "Sign out", which already
        // wipes local data itself via signOut() below for privacy on shared
        // devices) or because the session/token silently expired or was
        // invalidated. We can't tell those two apart from this event alone, so
        // we deliberately do NOT wipe local app data here: doing so would
        // destroy any transactions the user entered locally that hadn't been
        // pushed yet, the moment their session happened to expire. Only sync
        // bookkeeping (outbox, pulledOnce, knownIds) is reset — the local data
        // itself stays untouched and keeps working fully offline.
        recoveryMode = false;
        pulledOnce = false;
        knownIds = { accounts: new Set(), categories: new Set(), investments: new Set(), transactions: new Set() };
        if (pullTimer) clearInterval(pullTimer);
        setStatus('signed-out');
        rerenderRef && rerenderRef();
        return;
      }

      // Signed in
      if (!wasSignedIn) {
        // Fresh login on this device/session: server always wins.
        pulledOnce = false;
        knownIds = { accounts: new Set(), categories: new Set(), investments: new Set(), transactions: new Set() };
        await Outbox.clear();
      }
      setStatus('syncing');
      await pullAll();
      if (pullTimer) clearInterval(pullTimer);
      pullTimer = setInterval(pullAll, PULL_INTERVAL_MS);
    });

    // Resume existing session on page load (already-logged-in reload)
    const existing = await SupaService.getSession();
    if (existing && existing.user) {
      session = existing;
      uid = existing.user.id;
      setStatus('syncing');
      await pullAll();
      if (pullTimer) clearInterval(pullTimer);
      pullTimer = setInterval(pullAll, PULL_INTERVAL_MS);
    } else {
      setStatus('signed-out');
    }
  }

  /* ---- Auth actions used by index.html ---- */
  async function signInGoogle() { return SupaService.signInWithGoogle(); }
  async function signInPassword(email, pw) { return SupaService.signInPassword(email, pw); }
  async function signUp(email, pw) { return SupaService.signUp(email, pw); }
  async function resetPassword(email) { return SupaService.resetPassword(email); }
  async function updatePassword(pw) { return SupaService.updatePassword(pw); }
  function isPasswordRecovery() { return recoveryMode; }
  function clearRecoveryMode() { recoveryMode = false; }
  function isSignedIn() { return !!uid; }
  function currentEmail() { return session && session.user ? session.user.email : ''; }
  function getStatus() { return status; }
  function onStatusChange(fn) { statusListeners.push(fn); }

  async function signOut() {
    await SupaService.signOut();
    uid = null; session = null; recoveryMode = false; pulledOnce = false;
    knownIds = { accounts: new Set(), categories: new Set(), investments: new Set(), transactions: new Set() };
    if (pullTimer) clearInterval(pullTimer);
    await IDB.set(SYNC_STATE_KEY, null);
    await Outbox.clear();
    setStatus('signed-out');
  }

  /* ---- Manual pull trigger (exposed for debugging / pull-to-refresh) ---- */
  async function pull() { return pullAll(); }

  return {
    init, notifyLocalChange, pull,
    signInGoogle, signInPassword, signUp, resetPassword, updatePassword,
    isPasswordRecovery, clearRecoveryMode,
    signOut, isSignedIn, currentEmail,
    getStatus, onStatusChange
  };
})();

window.SyncEngine = SyncEngine;
window.SupaService = SupaService;
