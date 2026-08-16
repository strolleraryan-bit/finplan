# FinPlan PWA — Project Context & Debug History

## ⚠️ MANDATORY RULE FOR CLAUDE — VERIFY BEFORE DELIVERING
Before presenting ANY generated file (sync-engine.js, SQL, etc.) to the user,
Claude MUST run these checks in the sandbox and only then call present_files:

1. **Syntax check** — `node --check <file>.js` must pass with no errors.
2. **Checksum/diff check** — confirm the file actually in `/mnt/user-data/outputs/`
   is byte-identical to whatever was just edited (`md5sum` both, compare).
3. **Key-symbol check** — grep for every function/global the file is expected
   to expose (e.g. `IdMigration`, `pulledOnce`, `SyncEngine`, `window.IDB`)
   and confirm the count matches expectations — not zero.
4. **No stale copy** — if editing was done via `str_replace` on a `/tmp/`
   working copy, re-`cp` it to `/mnt/user-data/outputs/` immediately before
   calling `present_files`. Never call `present_files` on a path that wasn't
   just freshly copied/written in the same turn.
5. Only after all 4 checks pass, call `present_files`.

This project has repeatedly broken because an outdated or half-edited file
was delivered by mistake. This checklist is not optional — skipping it has
directly caused hours of debugging for the user.

## ⚠️ MANDATORY RULE — ALWAYS DELIVER FULL ZIP + UPDATED README TOGETHER
Whenever ANY project file is created or modified (sync-engine.js, index.html,
SQL scripts, etc.), Claude must NOT just hand over that single file in
isolation. Every such delivery must include, in the same turn:

1. **The individual updated file(s)** — as always, for quick reference/diff.
2. **This README (FINPLAN_CONTEXT.md) updated** to reflect what changed —
   new fixes, new known gaps, new file versions, updated "Current Status".
3. **A full deployable `finplan-deploy.zip`** rebuilt fresh from ALL current
   project files (`index.html`, `sync-engine.js`, `sw.js`, `manifest.json`,
   the three icon files, and a copy of this README as `README.md` inside
   the zip) — never a zip left over from a previous turn.

Before zipping, Claude must run the full verification checklist above on
EVERY file going into the zip (not just the one that changed), extract the
freshly-built zip back out, and re-verify the extracted copies (syntax
check, key-symbol grep) before calling `present_files` on the zip. This
catches accidental staleness in files that weren't directly edited this
turn but are still being bundled.

If `index.html` was not modified by Claude in the current project state,
the zip must still bundle whatever is the most recently confirmed-current
copy of it, and the README must state clearly whether `index.html` reflects
any changes the user may have made independently on GitHub since it was
last uploaded to this chat.

---



## Project Overview
**FinPlan** is a personal finance PWA built by Aryan (UP Police ASI, "Chai and Concepts" brand).
- **Deployed at:** `strolleraryan-bit.github.io/finplan/`
- **Stack:** Vanilla JS, single HTML file (`index.html`) + `sync-engine.js` + `sw.js` + `manifest.json`
- **Backend:** Supabase (PostgreSQL + Auth + RLS)
- **Auth:** Google OAuth via Supabase
- **Storage:** IndexedDB (via `IDB` helper) as primary local store, localStorage as secondary
- **Sync:** Custom `sync-engine.js` with outbox queue, diff-based push, pull with `lastPulledAt`

---

## Supabase Project
- **URL:** `https://cbauurxbzlbjfxudbshh.supabase.co`
- **Anon Key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNiYXV1cnhiemxiamZ4dWRic2hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MjE4NjgsImV4cCI6MjEwMjI5Nzg2OH0.IlR3wDhWpyil6vtNm2SCOeojc1bdVjX_c9NxI3j5p90`
- **User ID (Aryan):** `d4c1e491-7208-451c-b70d-8edad26d7aa1`

---

## Database Tables

### `transactions` (21 columns)
| Column | Type | Nullable |
|--------|------|----------|
| id | uuid | NO |
| user_id | uuid | NO |
| type | text | NO |
| date | date | NO |
| amount | numeric | NO |
| account_id | uuid | YES (was NOT NULL — fixed) |
| category_id | uuid | YES (was NOT NULL — fixed) |
| notes | text | YES |
| tags | ARRAY | YES |
| location | text | YES |
| attachment | jsonb | YES |
| credit | jsonb | YES |
| loan | jsonb | YES |
| reminder | jsonb | YES |
| linked_investment_id | uuid | YES |
| realized_pl | numeric | YES |
| txn_id | text | YES |
| created_at | timestamptz | NO |
| updated_at | timestamptz | NO |
| is_deleted | boolean | NO |
| deleted_at | timestamptz | YES |

### `accounts` (11 columns)
Standard fields: id, user_id, name, type, icon, color, opening_balance, created_at, updated_at, is_deleted, deleted_at

### `categories` (11 columns)
Standard fields: id, user_id, kind, name, icon, color, locked, created_at, updated_at, is_deleted, deleted_at

### `investments` (18 columns)
Standard fields: id, user_id, name, category, purchase_date (nullable), purchase_price, quantity, invested_amount, current_value, notes, history (jsonb), linked_expense_id (uuid, nullable), txn_id, closed, created_at, updated_at, is_deleted, deleted_at

### `settings` (10 columns)
Standard fields: user_id, currency, theme, accent, date_format, default_account_id, notif_enabled, notified_log, created_at, updated_at

---

## RLS Policies (all tables)
All 5 tables have these policies:
- `SELECT`: `auth.uid() = user_id`
- `INSERT WITH CHECK`: `auth.uid() = user_id`
- `UPDATE`: `auth.uid() = user_id`
- `DELETE`: `auth.uid() = user_id`

**Note:** Original INSERT policies on accounts, categories, investments, settings had `null` qual (broken). Fixed by dropping and recreating with `WITH CHECK`.

---

## sync-engine.js Architecture

### Key globals
- `SyncEngine` — main export, exposes `init()`, `notifyLocalChange()`, `signOut()`
- `SupaService` — Supabase client wrapper, exposes `upsertBatch()`, `getSession()`, `signOut()`
- `SyncOutbox` — IndexedDB outbox queue (`IDB.get/set('outbox', [...])`)
- `IDB` — IndexedDB wrapper: `IDB.get(key)`, `IDB.set(key, value)`

### Sync flow
1. `saveDB(db)` in `index.html` calls `SyncEngine.notifyLocalChange(db)`
2. `notifyLocalChange` diffs `db` against `lastSnapshot`, finds changed records
3. Changed records → `toAccountRow()` / `toCategoryRow()` / `toInvestmentRow()` / `toTransactionRow()` → pushed to `SyncOutbox`
4. `scheduleFlush()` → `flush()` → `SupaService.upsertBatch()` → Supabase POST
5. On success: item removed from outbox. On failure: `attempts++`, retry with backoff (max 10 attempts)
6. `pullRemoteChanges()` runs every 30s, pulls changes since `lastPulledAt`

### Row builders (in sync-engine.js)
All row builders now have UUID guards — return `null` for legacy non-UUID ids:
```js
function toTransactionRow(t, db) {
  if (!isUUID(t.id)) return null;
  ...
}
function toInvestmentRow(inv) {
  if (!isUUID(inv.id)) return null;
  linked_expense_id: (inv.linkedExpenseId && isUUID(inv.linkedExpenseId)) ? inv.linkedExpenseId : null,
  ...
}
function toCategoryRow(c) {
  if (!isUUID(c.id)) return null;
  ...
}
function toAccountRow(a) {
  if (!isUUID(a.id)) return null;
  ...
}
```

### notifyLocalChange null check
```js
const row = table === 'accounts' ? toAccountRow(rec) : ...
if (row === null || row === undefined) continue; // skip legacy ids
```

### signOut fix
```js
async function signOut() {
  const c = getClient(); if (!c) return;
  try { await c.auth.signOut(); } catch (e) { /* session already gone, ignore 403 */ }
}
```

### Server-wins on first login
```js
if (wasSignedOut) {
  await IDB.set('outbox', []);
  await IDB.set('sync_meta', { lastPulledAt: {} });
  lastSnapshot = null;
}
await pullRemoteChanges(applyToDb, rerender);
```

---

## Bug History & Fixes

### Bug 1: transactions upsert 400
**Cause:** `account_id` and `category_id` columns had NOT NULL constraint  
**Fix:** `ALTER TABLE transactions ALTER COLUMN account_id DROP NOT NULL;`

### Bug 2: INSERT policy broken on all tables
**Cause:** Original INSERT policies had `null` qual  
**Fix:** Drop and recreate with `WITH CHECK (auth.uid() = user_id)` on all 5 tables

### Bug 3: Legacy non-UUID ids throughout local DB
**Cause:** App originally used custom IDs like `msusr7q7...` instead of UUIDs. UUID migration ran but missed some records and foreign key references.  
**Fix:** Full migration script run in DevTools (migrated 60 records). Then individual fixes for leftover legacy IDs in outbox and app_state.

### Bug 4: `linked_expense_id` in investments was legacy ID
**Cause:** Migration didn't cover foreign key references inside investments  
**Fix:** UUID guard in `toInvestmentRow` + nullify non-UUID `linked_expense_id`

### Bug 5: Categories upsert 400
**Cause:** Default categories created before UUID migration had legacy IDs  
**Fix:** Clear outbox (they exist on server with correct UUIDs already)

### Bug 6: signOut 403
**Cause:** Session already expired before signOut called  
**Fix:** try/catch in `SupaService.signOut()`

### Bug 7: Second device showing local data instead of server data on login
**Cause:** On `wasSignedOut`, engine was pushing local data up before pulling server data  
**Fix:** Server-wins strategy — clear outbox on login, pull first

### Bug 8: Old outbox items never cleared after max attempts (10)
**Cause:** Dead items stay in outbox, engine shows "sync error" UI permanently  
**Fix:** Manually `await IDB.set('outbox', [])` in DevTools when stuck

---

## DevTools Debug Commands

### Check outbox
```javascript
const ob = await IDB.get('outbox');
console.log('count:', ob?.length);
ob?.forEach(i => console.log(i.table, i.op, 'attempts:', i.attempts, 'id:', i.id));
```

### Clear outbox
```javascript
await IDB.set('outbox', []);
```

### Force fresh pull from Supabase
```javascript
await IDB.set('sync_meta', { lastPulledAt: {} });
```

### Full reset (wipe local, pull from server)
```javascript
await IDB.set('outbox', []);
await IDB.set('sync_meta', { lastPulledAt: {} });
await IDB.set('app_state', null);
// then hard refresh
```

### Find legacy ID transactions
```javascript
{
const db = await IDB.get('app_state');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const all = [...(db.income||[]), ...(db.expense||[])];
all.forEach(t => console.log(UUID_RE.test(t.id) ? '✓' : '✗ LEGACY', t.id, t.amount));
}
```

### Migrate all legacy IDs in app_state
```javascript
{
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = v => typeof v === 'string' && UUID_RE.test(v);
const map = {};
const db = await IDB.get('app_state');
const collect = arr => (arr||[]).forEach(r => { if (r?.id && !isUUID(r.id)) map[r.id] = crypto.randomUUID(); });
collect(db.accounts); collect(db.categoriesIncome); collect(db.categoriesExpense);
collect(db.income); collect(db.expense); collect(db.investments);
const remap = arr => (arr||[]).forEach(r => { if (r?.id && map[r.id]) r.id = map[r.id]; });
remap(db.accounts); remap(db.categoriesIncome); remap(db.categoriesExpense);
remap(db.income); remap(db.expense); remap(db.investments);
[...(db.income||[]), ...(db.expense||[])].forEach(t => {
  if (t.accountId && map[t.accountId]) t.accountId = map[t.accountId];
  if (t.linkedInvestmentId && map[t.linkedInvestmentId]) t.linkedInvestmentId = map[t.linkedInvestmentId];
});
(db.investments||[]).forEach(inv => {
  if (inv.linkedExpenseId && map[inv.linkedExpenseId]) inv.linkedExpenseId = map[inv.linkedExpenseId];
});
if (db.settings?.defaultAccount && map[db.settings.defaultAccount]) db.settings.defaultAccount = map[db.settings.defaultAccount];
await IDB.set('app_state', db);
await IDB.set('outbox', []);
console.log('migrated:', Object.keys(map).length, 'records');
}
```

### Test upsert directly
```javascript
const { createClient } = supabase;
const c = createClient('https://cbauurxbzlbjfxudbshh.supabase.co', 'ANON_KEY');
const session = await c.auth.getSession();
const { data, error } = await c.from('transactions').upsert([{
  id: crypto.randomUUID(),
  user_id: session.data.session?.user?.id,
  type: 'expense', date: '2026-08-16', amount: 1
}], { onConflict: 'id' });
console.log('error:', JSON.stringify(error, null, 2));
```

### Force fresh pull on mobile (address bar trick)
```
javascript:IDB.set('sync_meta',{lastPulledAt:{}}).then(()=>location.reload())
```

---

## SQL Reference

### Check all columns
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'transactions'
ORDER BY ordinal_position;
```

### Check RLS policies
```sql
SELECT tablename, policyname, cmd, qual
FROM pg_policies
WHERE tablename IN ('accounts','categories','investments','settings','transactions');
```

### Fix INSERT policies on all tables
```sql
DROP POLICY IF EXISTS accounts_insert_own ON accounts;
CREATE POLICY accounts_insert_own ON accounts FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS categories_insert_own ON categories;
CREATE POLICY categories_insert_own ON categories FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS investments_insert_own ON investments;
CREATE POLICY investments_insert_own ON investments FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS settings_insert_own ON settings;
CREATE POLICY settings_insert_own ON settings FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS transactions_insert_own ON transactions;
CREATE POLICY transactions_insert_own ON transactions FOR INSERT WITH CHECK (auth.uid() = user_id);
```

### Drop NOT NULL constraints
```sql
ALTER TABLE transactions ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE transactions ALTER COLUMN category_id DROP NOT NULL;
ALTER TABLE investments ALTER COLUMN name DROP NOT NULL;
ALTER TABLE investments ALTER COLUMN category DROP NOT NULL;
ALTER TABLE investments ALTER COLUMN purchase_date DROP NOT NULL;
ALTER TABLE investments ALTER COLUMN invested_amount DROP NOT NULL;
ALTER TABLE investments ALTER COLUMN current_value DROP NOT NULL;
ALTER TABLE investments ALTER COLUMN history SET DEFAULT '[]'::jsonb;
ALTER TABLE investments ALTER COLUMN closed SET DEFAULT false;
ALTER TABLE investments ALTER COLUMN is_deleted SET DEFAULT false;
```

---

## SESSION 2 FIXES (Aug 16, 2026 — evening)

### Bug 9: Delete karne ke baad transaction wapas aa jata tha — MAJOR FIX
**Root cause:** v3.0 rewrite mein `pushAll()` sirf upsert karta tha — kisi
bhi record ko delete karne ka koi tareeka nahi tha Supabase ko batane ka.
User jab app mein koi transaction/account/category/investment delete karta
tha, woh sirf local array se hat jata tha; Supabase mein woh record
`is_deleted: false` hi rehta tha. Har 20 sec ke full pull mein woh record
wapas fetch ho jata tha aur local state mein resurrect ho jata tha.

**Fix:** `knownIds` tracking add kiya gaya — har table (accounts, categories,
investments, transactions) ke liye ek `Set` maintain hota hai jo last-known
ids track karta hai. Har `pushAll()` call mein current local ids ko
`knownIds` se compare kiya jata hai; jo id `knownIds` mein tha but ab local
mein nahi hai, use "deleted" samjha jata hai aur `SupaService.softDelete()`
call hoti hai us par (`is_deleted: true, deleted_at: now()` set karta hai).
`knownIds` har successful pull/push ke baad refresh hota hai.

### Bug 10: Recent Transactions ka order/series sahi nahi tha
**Root cause:** `recentTx()` (index.html) same-date transactions ko sort
karne ke liye `id` ko tiebreaker use karta tha (`date+id` string compare).
Purane legacy ids (jaise `msuxxx`) timestamp-based the isliye sortable the,
lekin naye UUIDs completely random hain — isliye same-date transactions ka
order random/wrong dikhta tha.

**Fix (2 jagah):**
1. `sync-engine.js` — Supabase se transactions fetch karte waqt ab explicit
   `.order('date', {ascending:false}).order('created_at', {ascending:false})`
   use hota hai, taaki server se hi correct chronological order mile.
2. `index.html` — `recentTx()` ka sort comparator se `id` tiebreaker hata
   diya gaya; ab sirf `date` par sort hota hai. JS ka stable sort guarantee
   ki wajah se same-date items apna server-provided (already-correct) relative
   order maintain karte hain.
   
   **Minor known limitation:** agar same date par income aur expense dono
   maujood hain, to income items hamesha expense items se pehle dikhenge
   (chronological creation time ke bawajood), kyunki array concat order
   `income + expense` hai. Yeh cosmetic hai, data/calculation par asar nahi
   padta.

### Bug 11: `transferPairId` field missing tha
Bilkul `linkedCreditId` jaisa gap — transfer transactions (ek account se
doosre account mein paisa move karna) ke income/expense pair ko link karne
wala `transferPairId` field Supabase schema aur sync-engine row-builders
dono mein missing tha.

**Fix:**
- SQL: `ALTER TABLE transactions ADD COLUMN transfer_pair_id uuid;`
- `sync-engine.js`: `toTransactionRow`/`fromTransactionRow` dono mein
  `transfer_pair_id` add kiya gaya, same UUID-guard pattern ke saath.

### Bug 12 (cosmetic, cleaned up): "-₹1" transaction dikh raha tha
Yeh ek leftover test transaction thi jo humne earlier debugging session
mein DevTools se banayi thi (`id: bb7e72e9-...`, amount 1, koi account/
category nahi). `session2_fixes.sql` isse Supabase se delete kar deta hai.

### Realtime toggle clarification
Supabase Dashboard mein Realtime sirf `transactions` table par enabled hai,
baaki (`accounts`, `categories`, `investments`, `settings`) par disabled hai.
**Yeh humare current sync mechanism ke liye irrelevant hai** — `sync-engine.js`
Supabase Realtime channels ko subscribe hi nahi karta; hum poori tarah
polling-based hain (har 20 sec mein full pull). Realtime toggle chahe kisi
bhi table par ON/OFF ho, usse koi fark nahi padta abhi. Agar future mein
instant (sub-20-second) sync chahiye to Realtime subscriptions add ki ja
sakti hain — abhi ke liye ignore karo.

---


### sync-engine.js — now on v3.0 (full rewrite, not a patch chain)
Completely rewritten from scratch (not incrementally patched) because repeated
patching of the original v1 file kept reintroducing bugs. v3.0 design:

- **Pure full pull, every 20s** — no incremental `lastPulledAt` logic anywhere.
  Every pull fetches ALL rows from all 5 tables and fully replaces local state.
  This guarantees no record is ever missed due to timestamp/clock issues.
- **Outbox only used for offline resilience** — if offline, changes stay
  queued; the moment `online` event fires, outbox flushes then a full pull runs.
- **`pulledOnce` guard** — `notifyLocalChange` will NOT push anything until
  the first full pull after sign-in has completed. This prevents a fresh/reset
  device from pushing its default-seeded categories (new random ids) before
  it has synced the real server-side categories, which was causing
  `23505 duplicate key` conflicts on the `categories_user_id_kind_name_key`
  unique constraint.
- **23505 auto-recovery** — if a push still hits a unique-constraint conflict
  (e.g. two devices independently created a category with the same name),
  the engine does NOT show a persistent error state; it resets `pulledOnce`
  and re-pulls, adopting the server's version automatically.
- **Logout wipes local data completely** — `app_state`, `outbox` all cleared,
  `pulledOnce` reset to false. No stale data leaks to next login.
- **Login always server-wins** — `pulledOnce` reset to false on fresh sign-in,
  outbox cleared, full pull happens before anything can push.
- **`window.IdMigration = { run: migrateLegacyIds }`** — exposed globally
  because `index.html`'s `loadDB()` calls `IdMigration.run(db)` directly,
  independent of the sync engine's own internal migration call. Forgetting
  this causes `ReferenceError: IdMigration is not defined` at boot.
- **Renamed `IDB_STATE_KEY` → `SYNC_STATE_KEY`** internally (same value,
  `'app_state'`) to avoid a `SyntaxError: Identifier already declared`
  collision with `index.html`'s own top-level `const IDB_STATE_KEY`.
- **All row builders (`toAccountRow`, `toCategoryRow`, `toInvestmentRow`,
  `toTransactionRow`) return `null` for any non-UUID id** and are filtered
  out before upsert — legacy ids can never reach Supabase and cause a 400.

### Known-good file location
The current authoritative `sync-engine.js` is whatever was most recently
verified via the checklist above and delivered in this chat. If starting a
new chat, re-attach the latest delivered `sync-engine.js` rather than
re-deriving it from this description.

### Supabase side
- ✅ Supabase schema fully migrated (all columns present, NOT NULL constraints
  relaxed on `account_id`, `category_id`, investment fields)
- ✅ RLS INSERT policies fixed on all 5 tables
- ✅ `settings` has a UNIQUE constraint on `user_id` (needed for upsert
  onConflict to work)
- ✅ Duplicate accounts/categories cleanup script available (`complete_fix.sql`)
- ⚠️ Re-run the duplicate-cleanup DO blocks in `complete_fix.sql` any time
  `23505` errors reappear on `categories` or `accounts` — safe to re-run,
  idempotent.

### Data-type sync coverage (verified Aug 16, 2026)
Every data type the app creates is confirmed to push and pull correctly:

| Data type | Table | Status |
|---|---|---|
| Income transactions | `transactions` | ✅ |
| Expense transactions | `transactions` | ✅ |
| Credit (borrowed money) | `transactions.credit` (jsonb) | ✅ incl. EMI fields |
| Loan (lent money) | `transactions.loan` (jsonb) | ✅ incl. EMI fields |
| Credit/loan repayment linking | `transactions.linked_credit_id` | ✅ fixed Aug 16 — was missing, added column + code |
| Transfer pair linking | `transactions.transfer_pair_id` | ✅ fixed Aug 16 (session 2) — was missing, added column + code |
| Delete propagation (any table) | soft-delete via `is_deleted`/`deleted_at` | ✅ fixed Aug 16 (session 2) — deletes were not propagating to Supabase at all; records resurrected on next pull |
| Investments | `investments` | ✅ |
| Accounts | `accounts` | ✅ |
| Categories (income/expense) | `categories` | ✅ |
| Reminders (per-transaction) | `transactions.reminder` (jsonb) | ✅ |
| Settings (currency/theme/etc) | `settings` | ✅ |
| Notification dedup log | `settings.notified_log` | ✅ fixed Aug 16 — was reading from wrong path (`db.settings.notifiedLog` instead of `db.notifiedLog`) |

Two DB-level fixes shipped alongside sync-engine v3.0's push/pull rewrite:
- `add_linked_credit_id.sql` — adds the missing `linked_credit_id uuid` column
  to `transactions`. Must be run once in Supabase SQL Editor.
- `notifiedLog` path corrected in both `toSettingsRow` (push) and the pull
  merge block, reading/writing `db.notifiedLog` (top-level) instead of the
  non-existent `db.settings.notifiedLog`.

### Latest delivered package
A full deployable zip (`finplan-deploy.zip`) was assembled containing:
`index.html`, `sync-engine.js` (v3.0, all fixes above), `sw.js`,
`manifest.json`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`.

**Important:** `index.html` in that zip is the same one originally uploaded
(version `3-6-2`) — Claude has NOT modified `index.html` in this project,
only `sync-engine.js`. If the user made independent edits to `index.html`
directly on GitHub after uploading, those edits are NOT reflected in this
zip and must be merged in manually before deploying, or re-upload the
current `index.html` in a future chat so Claude can rebuild the zip against it.


---

### Outstanding pattern to watch for
If `IdMigration is not defined` or `Identifier already declared` errors
reappear after a deploy, it means GitHub Pages is still serving an old
cached/uncommitted `sync-engine.js` — verify directly at
`https://strolleraryan-bit.github.io/finplan/sync-engine.js` (Ctrl+F for
`IdMigration` and `pulledOnce`) before debugging further.

## Files in Repo (deploy these 7 files together)
- `index.html` — main app (238KB)
- `sync-engine.js` — sync logic (33KB)
- `sw.js` — service worker
- `manifest.json` — PWA manifest
- `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` — icons
