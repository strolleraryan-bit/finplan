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

## ⚠️ MANDATORY RULE — SQL FILES ARE NEVER BUNDLED IN THE DEPLOY ZIP
`finplan-deploy.zip` is meant to be extracted straight into the GitHub repo
for GitHub Pages deployment. GitHub Pages only serves static files — it
never executes `.sql` files, so bundling one in the zip is actively
misleading (it implies the user should push it to GitHub, which does
nothing).

Going forward:
- Any `.sql` fix file is delivered **separately**, as its own standalone
  file in the same turn — never added to `finplan-deploy.zip`.
- The zip only ever contains files meant to be deployed as-is to GitHub
  Pages: `index.html`, `sync-engine.js`, `sw.js`, `manifest.json`, the
  icon files, and `README.md` (README is harmless to include since GitHub
  Pages ignores it, but SQL is not harmless — it's actively confusing).
- When delivering a SQL fix, Claude must explicitly remind the user it
  goes into **Supabase SQL Editor**, not GitHub, and is a one-time run.


## ⚠️ MANDATORY RULE — ALWAYS DELIVER FULL ZIP + UPDATED README TOGETHER, BUT BE PRECISE ABOUT WHAT ACTUALLY CHANGED
Whenever ANY project file is created or modified (sync-engine.js, index.html,
SQL scripts, etc.), Claude must NOT just hand over that single file in
isolation. Every such delivery must include, in the same turn:

1. **The individual updated file(s)** — as always, for quick reference/diff.
2. **This README (FINPLAN_CONTEXT.md) updated** to reflect what changed —
   new fixes, new known gaps, new file versions, updated "Current Status".
3. **A full deployable `finplan-deploy.zip`** rebuilt fresh from ALL current
   project files (`index.html`, `sync-engine.js`, `sw.js`, `manifest.json`,
   the three icon files, and a copy of this README as `README.md` inside
   the zip) — never a zip left over from a previous turn. The zip exists
   purely for convenience (one download instead of manually reassembling
   files) — it does NOT mean the user needs to re-upload every file to
   GitHub every time.
4. **Claude must explicitly state which file(s) inside the zip actually
   changed this turn** (e.g. "only sync-engine.js changed this time — that's
   the only file you need to replace on GitHub") versus which are unchanged
   carry-overs bundled just so the zip stays complete and self-contained.
   Telling the user to blanket-replace all files when only one changed
   wastes their time — this was explicitly called out as bad advice on
   Aug 17, 2026. Diff each file going into the zip against the previous
   turn's delivered version before claiming it's unchanged.
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

### Bug 13: Fresh/naya Supabase account banane ke baad login karte hi accounts/categories khali dikhna
**Scenario:** Purana Supabase user delete karke, same email se naya account
banaya. Naye account ke liye Supabase mein genuinely 0 accounts, 0
categories, 0 transactions hain (expected — bilkul naya signup hai).

**Root cause:** App locally `defaultDB()` se seed hoti hai (2 default
accounts — Cash, Bank — aur default category list) jab tak koi real data na
ho. Lekin login ke turant baad `pullAll()` chalta hai, jo Supabase se
**0 rows** wapas laata hai (kyunki naya account hai), aur woh 0 rows se
local ke default accounts/categories ko **overwrite/wipe** kar deta tha —
result: na local mein kuch bacha, na Supabase mein kabhi gaya. Account/
Category dropdown poori tarah khali dikhta tha.

**Fix:** `pullAll()` mein ek naya check — agar yeh **first-ever pull** hai
(`!pulledOnce`) aur Supabase ke **saare 5 tables genuinely khali** hain
(`serverIsEmpty`), to local defaults ko wipe karne ke bajaye ulta karo:
current local default-seeded data ko turant `pushAll()` se Supabase par
push kar do, taaki woh naye account ka starting data ban jaye. Iske baad
normal sync flow chalta rehta hai.

### Bug 14: Deployment mismatch — user kept re-verifying an OLD deployed file
**Symptom:** Even after Bug 13's fix (`serverIsEmpty` branch calling
`migrateLegacyIds` before push) was delivered, the app kept behaving as if
the fix wasn't there — accounts/categories still not appearing after login.

**Root cause:** Checking the LIVE deployed `sync-engine.js` at
`strolleraryan-bit.github.io/finplan/sync-engine.js` confirmed the top-level
`migrateLegacyIds()` function definition WAS present (from an earlier
deploy), but the specific fix inside the `serverIsEmpty` block (which calls
`migrateLegacyIds(db)` before `pushAll`) was NOT present — meaning an
intermediate/stale version of the file got deployed instead of the final
one. This happens easily when copy-pasting large files by hand across
several iterative fixes in the same session.

**Fix / prevention:** Going forward, always verify a deploy by checking
for the MOST RECENTLY added fix's exact code, not just a function name
that may have existed in an earlier version too. The checksum below
should be cross-referenced: if the live file's checksum doesn't match,
the deploy is stale.

**Current verified `sync-engine.js` checksum (md5):** `31d84d19e665f4bc1e757096dcc531da`
(684 lines). If this doesn't match what's live on GitHub Pages, redeploy.

### Bug 15: Service Worker stale cache — THE REAL ROOT CAUSE of "deploy nahi ho raha" reports
**This explains the entire Bug-14-and-onward saga.** FinPlan is a PWA with
a Service Worker (`sw.js`) that uses a **cache-first** fetch strategy:

```js
self.addEventListener('fetch', (event) => {
  ...
  return caches.match(event.request).then((cached) => {
    const fetchPromise = fetch(event.request).then(networkResponse => {
      // updates cache in the BACKGROUND for next time
      ...
    });
    return cached || fetchPromise;   // <-- stale cache wins if present
  });
});
```

This means: once `sync-engine.js` is cached under a given `CACHE_NAME`,
**every subsequent app load serves the OLD cached copy instantly**, no
matter how many times a genuinely new `sync-engine.js` is pushed to GitHub.
The network fetch does happen in the background and updates the cache for
*next* time, but the currently-loading page still runs the stale version —
so a single reload is never enough, and every one of the "fix deployed but
nothing happened" reports in this session was very likely this exact
mechanism, not a bad fix or a bad deploy.

**Permanent fix:** `CACHE_NAME` in `sw.js` (currently `'finplan-v17'`) must
be bumped **every single time** `sync-engine.js` or `index.html` changes.
The Service Worker's `activate` handler already deletes any cache whose
name doesn't match the current `CACHE_NAME`:
```js
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
```
So bumping the version string is sufficient to force a full cache bust on
next load — **Claude must remember to bump this on every future deploy**
that touches `sync-engine.js` or `index.html`, and must call this out
explicitly every time.

**One-time unstick needed right now** (to clear whatever is currently
stuck in the browser from before this fix): run this in DevTools console
on the live site, then hard refresh:
```javascript
navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
caches.keys().then(names => names.forEach(n => caches.delete(n)));
location.reload();
```

---

## SESSION 3 (Aug 17, 2026)

### Feature: Login nudge popup + post-login redirect back to "add transaction"
**What was added (index.html only, no schema/sync-engine.js API changes):**
- On the dashboard, if `SyncEngine.getStatus()` resolves to `'signed-out'`
  (covers: first-ever open, explicit sign-out, and session/token expiry),
  a dismissible popup appears once per app open: *"Back up your data"* with
  **Maybe later** / **Sign in** buttons. It will not re-nag repeatedly in the
  same app session — but resets (can show again) after any successful
  sign-in, so a later session expiry will nudge again.
- Tapping **Sign in** in the popup sets a `localStorage` flag
  (`finplan_pending_login_intent`) and jumps to Settings → Cloud Sync. This
  flag is read via `localStorage` (not an in-memory variable) specifically
  because Google OAuth sign-in reloads the page — an in-memory flag would be
  lost across that redirect.
- Once sign-in actually completes (`SyncEngine` status becomes `'syncing'`/
  `'synced'`), if that flag is set it's cleared and the user is dropped
  straight into the Quick Add sheet (`openQuickAddSheet()`) on the dashboard.
  This works for both email/password sign-in (same-page) and Google OAuth
  (full reload) because the flag survives in `localStorage` and the check
  runs from `SyncEngine.onStatusChange`, which is (re)registered on every
  `boot()`.
- Signing in manually from Settings (not via the popup) does **not** trigger
  this redirect — only sign-ins initiated from the popup's "Sign in" button
  set the intent flag.

### Cloud Sync section redesign (Settings)
Replaced the old side-by-side "Sign in" / "Create account" buttons (which
shared the same fields and could be ambiguous about which one to press) with
a clearer **Sign in / Create account tab toggle** above the email/password
fields, a single primary submit button whose label matches the active tab,
a password show/hide toggle, and client-side email-format validation before
hitting the network (previously only checked for non-empty). "Forgot
password?" only shows on the Sign in tab.

### Bug 16: Session expiry could silently wipe local (unsynced) data
**Root cause:** `SyncEngine`'s `onAuthStateChange` listener treated **every**
transition to signed-out the same way — including an automatic one caused by
the session/refresh token silently expiring — and wiped `app_state` in
IndexedDB (`await IDB.set(SYNC_STATE_KEY, null)`) every time. This was
correct/intentional for an explicit "Sign out" tap (documented privacy
behavior — see "Logout wipes local data completely" above, and `signOut()`
still does this on purpose), but meant that if a session merely expired in
the background, any local-only transactions not yet pushed to Supabase could
be lost the next time the app was reloaded, because `loadDB()` treats a
`null` value in IndexedDB as "nothing saved yet" and falls back to
localStorage or a fresh default DB.

**Fix:** The `onAuthStateChange` listener's `!uid` branch no longer wipes
`SYNC_STATE_KEY`. It still resets sync bookkeeping (`pulledOnce`, `knownIds`,
stops the pull timer) so a future sign-in re-syncs cleanly, but local data
is left untouched. The explicit `signOut()` function (called only when the
user actually taps "Sign out") is unchanged and still wipes local data on
purpose for shared-device privacy.

### Files changed this session
- `index.html` — login nudge popup, post-login redirect, Cloud Sync UI
  redesign, 3 new icons (`cloud`, `eye`, `eyeOff`).
- `sync-engine.js` — Bug 16 fix only (removed the local-data wipe from the
  auto sign-out path).
- `sw.js` — `CACHE_NAME` bumped `finplan-v17` → `finplan-v18` (mandatory
  any time `index.html` or `sync-engine.js` changes — see Bug 15).
- Unchanged this session: `manifest.json`, icon PNGs.

**Current checksums (md5):**
- `index.html`: `c2b88ed552e50710b3d1cf1c00a74956`
- `sync-engine.js`: `6cf7380ce9f68b349a223614e2cd8dc0`

### Follow-up (same day): optional nudge replaced with a hard sign-in gate
The dismissible "Back up your data" dashboard popup above was **removed**
based on direct feedback — it appeared preemptively on every app open and
still let the user proceed to add transactions locally while signed out,
which is exactly the state that silently doesn't sync. Replaced with:

- **No proactive popup on open.** The only passive signal that sync is off
  is the existing topbar pill ("Sync off").
- **A hard gate at the point of action.** `requireSignedIn(intent)` is
  called at the top of every function that opens a form for creating or
  editing a transaction-type entry: `openTxModal` (income/expense, add
  *and* edit), `openInvestModal` (add and edit), `openTransferModal`, and
  `openCreditModal` (Credit Taken / Credit Given). If not signed in, the
  form never opens — instead a **"Sign in required"** modal appears with a
  single direct **Sign in** button (no "maybe later" / skip option) that
  jumps to Settings → Cloud Sync.
- **Intent-based redirect back**, same mechanism as before
  (`finplan_pending_login_intent` in `localStorage`, read by
  `handlePostLoginRedirect` off `SyncEngine.onStatusChange`): for "add new"
  actions the matching form reopens automatically the moment sign-in
  completes — works across Google OAuth's full-page redirect too. Editing
  an existing entry shows the same gate but does not auto-reopen that
  specific record after login (the underlying data may change once the
  post-login sync completes); the user lands back on the dashboard instead.
- **Known scope limit:** the Credit detail/actions screen
  (`openCreditDetail` — where partial repayments, EMI payments, and
  edits/deletes on an *existing* credit or lending entry happen) is **not**
  gated yet. It doubles as a read-only detail view, so gating the whole
  screen would also block viewing an existing credit's history while
  signed out. If per-action gating inside that screen (repay/edit/delete
  specifically) is wanted, that's a follow-up, not yet done.
- Account creation/editing and category management remain ungated — they're
  treated as local setup, not "transactions".

**Files changed in this follow-up:** `index.html` only (`sync-engine.js`
untouched, checksum unchanged from Session 3 above).
- `index.html` new checksum: `85bd61bf005b1d1dbb98acc63e73d653`
- `sw.js`: `CACHE_NAME` bumped `finplan-v18` → `finplan-v19` (index.html
  changed again).

---

## SESSION 4 (Aug 17, 2026 — later)

### Bug 17: "Credit Given" Save button did nothing (silent JS crash, no error shown)
**Symptom reported by user:** Opening Credit → Credit Given → "+ Add Credit
Given", filling the form, and tapping **Save** did nothing at all — no
toast, no error, modal just stayed open. (Credit → Credit Taken worked
fine.) Separately, the user also asked why Net Worth showed as negative
despite having bank balance — that part turned out to be **correct
behavior**, not a bug: the bank balance was money borrowed via "Credit
Received" (a Payable) that hadn't been repaid yet, so it's subtracted from
Net Worth by design (`Cash + Bank + Investments + Receivables − Payables`).
No code change was needed for that part.

**Root cause (in `openCreditModal`, the shared Add Credit Taken/Given
modal):** The `#cr-tenure` input only exists in the DOM when
`isTaken === true` (it's inside the EMI-fields block, which is only
rendered for Credit Taken — Credit Given has no EMI concept). But the
event-wiring code queried it **unconditionally**:
```js
root.querySelector('#cr-tenure').addEventListener('input', ...);
```
For Credit Given, `querySelector('#cr-tenure')` returns `null`, so this
line threw `TypeError: Cannot read properties of null (reading
'addEventListener')`. Since this line runs earlier in the same synchronous
`onMount` callback than the line that binds the Save button's `onclick`
handler, the thrown error aborted the rest of the callback — **the Save
button's click handler was never attached** for Credit Given. The modal UI
rendered fine (that's separate template code), so nothing *looked* broken
until the user actually tried to save.

**Fix:** guarded the lookup so it only wires the listener when the element
actually exists:
```js
const tenureEl0 = root.querySelector('#cr-tenure');
if(tenureEl0) tenureEl0.addEventListener('input', ()=>{ updateEmiSummary(); updateIntSummary(); });
```
Audited every other `#cr-emi-amt` / `#cr-tenure` / `#cr-emi-day` reference
in the same modal — all others are either already inside an `isTaken`
branch or inside `updateEmiSummary()`, which itself early-returns via a
null-check on `#emi-total-summary` (also EMI-only) before reaching those
fields. This was the only unguarded one.

**Files changed this session:** `index.html` only (`sync-engine.js`
untouched).
- `index.html` new checksum: `47757d8972cd472a23958b8591a0e863`
- `sw.js`: `CACHE_NAME` bumped `finplan-v19` → `finplan-v20` (index.html
  changed again — required, per the mandatory rule above, or browsers keep
  serving the broken cached copy).

---

## SESSION 5 (Aug 17, 2026 — later)

### Bug 18: Adding a new Investment triggered a permanent "sync error" — and broke sync for EVERYTHING added after it
**Symptom reported by user:** Investment add karne ke baad sync error aa raha
tha. Investigation confirmed the error wasn't isolated to investments — once
it happened once, every subsequent save (a new transaction, a Credit Given/
Taken entry, etc.) also showed a sync error, because `pushAll()` pushes the
**entire** `investments` array on every push (not just the newly changed
record), and one bad record in that array made the whole push throw before
transactions/settings ever got a chance to sync in that call.

**Root cause:** `openInvestModal`'s "Add Investment" form has no input field
for Purchase Price at all — only Name, Category, Date, Invested Amount,
Quantity, Current Value, Notes. But the default object used to seed a new
investment set `purchasePrice: ''` (empty string), and the Save handler
copied that value through unchanged (`purchasePrice: inv.purchasePrice`).
So **every** investment created via "+ Add Investment" ended up with
`purchasePrice: ''` forever — there was no code path that ever turned it
into a number. `toInvestmentRow()` in `sync-engine.js` then sent that
empty string straight through to Supabase's `purchase_price` column, which
is `numeric`. Postgres/PostgREST rejects `''` for a numeric column
(`invalid input syntax for type numeric: ""`), so the `investments` upsert
in `pushAll()` threw — and because `pushAll()` runs
accounts→categories→**investments**→transactions→settings sequentially
inside one `try` block, that thrown error aborted the whole function before
transactions or settings were pushed, landing on `setStatus('error')`.
Since `pushAll()` re-pushes the full (unfiltered) investments array on
every single save anywhere in the app, the same bad record kept re-triggering
the same failure on every subsequent add — not just investment adds.

**Fix (two layers, both applied):**
1. `sync-engine.js` — new `toNumOrNull(v)` helper: returns `null` for `''`/
   `null`/`undefined`, otherwise `Number(v)` (or `null` if that's `NaN`).
   `toInvestmentRow()` now uses it for both `purchase_price` and `quantity`
   instead of the old `?? null` (which only catches `null`/`undefined`, not
   `''`). This is the important fix — it's self-healing: any investment
   already sitting in a user's local IndexedDB with `purchasePrice: ''`
   from before this fix will automatically sync correctly on the very next
   push after the update loads, no DevTools command or SQL needed.
2. `index.html` — new-investment default object now seeds
   `purchasePrice: null` instead of `purchasePrice: ''`, so the bad value
   is never created in the first place going forward.
- Confirmed `purchasePrice` isn't used in any calculation (CAGR uses
  `purchaseDate` + `investedAmount`/`currentValue` only), so this fix has
  zero effect on any displayed number — purely a sync-layer data-hygiene fix.
- While investigating, reviewed all other numeric fields going into typed
  Supabase columns (`invested_amount`, `current_value`, transaction `amount`,
  account `opening_balance`) — all of those are already always produced via
  `parseFloat(...)||0`/`||null` in their respective save handlers, so they
  can't carry an empty string the way `purchasePrice` could. `credit`/`loan`
  are `jsonb` columns, so numbers stored inside them (rate, EMI amount, etc.)
  don't hit this class of bug regardless of type, since Postgres doesn't
  type-check individual keys inside a jsonb blob.
- Also reviewed Net Worth, CAGR, credit/EMI outstanding, and account balance
  calculations for correctness — all consistent with documented behavior
  (`Cash + Bank + Investments + Receivables − Payables`; CAGR from purchase
  date + invested/current value; EMI/credit outstanding from
  `computeCreditFinancials`/payments history). No issues found.

**Files changed this session:** `index.html`, `sync-engine.js`.
- `index.html` new checksum: `eda48ea33ee662bf0c218e5b153748f3`
- `sync-engine.js` new checksum: `c8048e3b264553236249b2d7e4bc9f6b`
- `sw.js`: `CACHE_NAME` bumped `finplan-v20` → `finplan-v21` (both
  `index.html` and `sync-engine.js` changed — mandatory per Bug 15).

---

## SESSION 6 (Aug 18, 2026)

### Bug 19: "Personal" category expense (and any newly added/edited category) silently failed to save/sync — root cause affected ALL new data, not just categories
**Symptom reported by user:** Adding an expense under the "Personal" category
didn't save/sync. Separately, adding or editing a category from
Settings → Manage Categories also didn't save/sync.

**Root cause (two compounding bugs):**
1. **`uid()` in `index.html`** (used for the id of every single new record —
   transactions, categories, accounts, investments, transfers, credit/loan
   entries) generated a non-UUID id (`Date.now().toString(36) + random`),
   not a real UUID. Every row builder in `sync-engine.js` silently drops
   (returns `null` for) any record whose id isn't a valid UUID — by design,
   so a legacy id can never reach Supabase and cause a 400. This meant
   **every brand-new record created anywhere in the app** relied entirely on
   `migrateLegacyIds()` inside `notifyLocalChange()` to rewrite its id to a
   real UUID *before* that same push.
2. **That rewrite was never persisted.** `saveDB()` writes `DB` to
   IndexedDB, *then* calls `SyncEngine.notifyLocalChange(DB)`, which is
   where `migrateLegacyIds()` actually runs and mutates the id in place.
   Nothing wrote the migrated (UUID) id back to IndexedDB afterward. So on
   the very next app reload, `loadDB()`'s own `IdMigration.run()` sees the
   same still-legacy id sitting in IndexedDB and generates **a different,
   new random UUID for it** — one that doesn't match whatever id was
   already pushed to Supabase moments earlier. Pushing that under a new id
   creates a duplicate row and, for categories specifically, collides with
   the `categories_user_id_kind_name_key` unique constraint → `23505`.
   Since `pushAll()` pushes accounts → categories → investments →
   transactions → settings sequentially inside one `try` block, a `23505`
   on the categories step aborted the transactions push for that same call
   — so a transaction saved around the same time (e.g. a "Personal"
   expense) never reached Supabase. The `23505` auto-recovery path then
   re-pulls and does a **full replace** of local `income`/`expense` from
   the server, silently discarding whatever local transaction hadn't been
   confirmed pushed yet. Net effect: the expense looked saved in the UI for
   a moment, then vanished on the next 20-second pull cycle (or next
   reload) without any visible error.
   This could in principle affect *any* new record, not only "Personal" —
   it surfaced there first because that category (or a category added/
   edited around the same time) happened to trigger the name-collision path.

**Fix (two layers, both applied):**
1. `index.html` — `uid()` now generates a real UUID
   (`crypto.randomUUID()`, with the same manual fallback `sync-engine.js`
   already uses) instead of a timestamp+random string. Every new record is
   a valid UUID from the moment it's created, so `migrateLegacyIds()` has
   nothing to do for anything created going forward — this closes the bug
   at the source for all record types (transactions, categories, accounts,
   investments), not just categories.
2. `sync-engine.js` — `notifyLocalChange()` now persists the db to
   IndexedDB immediately after `migrateLegacyIds()` if migration actually
   changed anything, instead of only mutating in memory. This is a
   defense-in-depth fix for any *existing* installs that still have
   old legacy-id records sitting in IndexedDB from before fix #1 — their
   migrated UUID now survives a reload instead of being silently
   regenerated (and re-conflicted) every time.
- Reviewed every other `id:uid()` call site (transactions, transfers,
  credit/loan entries, investments, accounts, new-category-from-Settings) —
  all go through the same `uid()` function, so all are fixed by change #1.
- Did not touch the same-date sort tiebreaker in the Transactions list
  filter (`list.sort(...(a.date+a.id)...)`) — this is a pre-existing
  cosmetic-only ordering quirk once ids are randomized (same category of
  issue as Bug 10, just a different screen), not the reported bug. Flagging
  as a known minor gap, not fixed this session.

**Files changed this session:** `index.html`, `sync-engine.js`, `sw.js`.
- `index.html` new checksum: `96258c0d5f5d550b0e5899efb835858d`
- `sync-engine.js` new checksum: `88330882b8b9ce4abcdda57b56e05520`
- `sw.js`: `CACHE_NAME` bumped `finplan-v21` → `finplan-v22` (both
  `index.html` and `sync-engine.js` changed — mandatory per Bug 15).

---

## SESSION 7 (Aug 18, 2026 — later)

### Feature: Search, filter & sort for Income/Expense lists
**What was added (`index.html` only — no schema or `sync-engine.js` changes,
this is pure local UI over the existing `income`/`expense` arrays):**
- **Search** (already existed, unchanged): free-text across notes,
  category, tags, account name, credit/loan person name.
- **Category filter** (already existed, unchanged): tabs above the list.
- **Account filter** (already existed, unchanged): dropdown.
- **New — Date range filter:** From/To date inputs (inclusive both ends).
- **New — Amount range filter:** Min/Max amount inputs.
- **New — Tag filter:** dropdown populated from the actual set of tags
  used across that type's entries (only rendered if at least one entry has
  a tag).
- **New — Sort:** kept the existing Newest/Oldest/Amount-high-low/
  Amount-low-high, added **Category A→Z** and **Category Z→A** (ties broken
  by date, newest first).
- The four new controls live in a collapsible "Date, amount & tag filters"
  `<details>` panel (auto-opens if any of them is already active, e.g. when
  navigating back), so the default view stays uncluttered.
- **Active-filter chips** row above the list: one removable chip per active
  filter (category/account/tag/date-from/date-to/min/max/search text) plus
  a "Clear all" chip. Removing a chip triggers a full view re-render so the
  search box, category tabs, and account/tag dropdowns visually reset too
  (not just the list).
- **Result count line** above the list: shows `"N of M entries · ₹total"`
  when any filter is active, or just `"N entries"` when not — so it's clear
  at a glance that a filter is narrowing the list, and what the filtered
  total adds up to.
- Filter state (`state.incomeFilter` / `state.expenseFilter`) extended with
  `tag`, `dateFrom`, `dateTo`, `amtMin`, `amtMax` — kept as separate
  per-type objects, same pattern as the existing `cat`/`acc`/`q`/`sort`
  fields; nothing persisted to Supabase (view-only, per-session local UI
  state, same as before).

### Side-fix while touching this code: same-date sort tiebreaker
The date sort comparator in this list used to break ties on same-date
entries with `(date+id).localeCompare(...)` — a leftover from when ids
were sortable timestamp-based strings (see Bug 10, which fixed the same
pattern on the Dashboard's "Recent Transactions" list but not this one).
Since Bug 19 (Session 6) made all ids real random UUIDs, that tiebreaker
was about to become fully random ordering for same-date entries here too.
Replaced with a plain date comparison + JS's stable sort (same fix pattern
as Bug 10), so same-date entries now keep their natural list order instead
of shuffling.

**Files changed this session:** `index.html` only (`sync-engine.js`
untouched, checksum unchanged from Session 6).
- `index.html` new checksum: `a05e12871ec084e213a45b4c79712bde`
- `sw.js`: `CACHE_NAME` bumped `finplan-v22` → `finplan-v23` (`index.html`
  changed — mandatory per Bug 15).

---

## Files in Repo (deploy these 8 files together)
- `index.html` — main app (238KB)
- `sync-engine.js` — sync logic (33KB)
- `sw.js` — service worker
- `manifest.json` — PWA manifest
- `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` — icons


---

## SESSION 8 (Aug 18, 2026 — later)

### Features Added: Credit Section Enhancements

**What was added (`index.html` only — no schema or `sync-engine.js` changes):**

#### 1. Search, Sort & Filter in Credit List
- **Search bar**: Real-time search by person name, mobile number, or notes.
- **Status filter**: Dropdown — All / Active / Overdue / Settled.
- **Sort**: Newest first, Oldest first, Amount ↓, Amount ↑, Outstanding ↓, Name A→Z.
- **Clear button**: Appears when any filter is active; resets all filters.
- **Result count**: Shows "N of M entries" when filtered; otherwise plain "N entries".
- Filter state stored in `state.creditFilter` (`{q, sort, status}`) — resets on tab switch (Taken ↔ Given).

#### 2. "Add More" Button in Credit Detail
- Credit detail modal now has an **Add More** button (besides Edit, Settle, Delete).
- Opens the Add Credit modal pre-filled with the same person's name and mobile number.
- Works for both Credit Taken and Credit Given — useful when same person gives/takes multiple credits over time.

#### 3. Edit Modal — Amount & Date Now Editable
- Previously the Edit credit record modal only allowed editing name, mobile, due date, and notes.
- Now also includes **Principal Amount** and **Date** fields.
- Editing amount recalculates `pendingAmount` correctly (new amount minus already repaid).

#### 4. Delete Button Always Visible (Bug Fix)
- Previously the btn-row had `flex:1` on all 3 buttons (Edit, Settle, Delete), causing Delete to wrap off-screen on narrow phones when all 3 were shown.
- Delete button now uses `btn-danger` style with `min-width:48px; flex-shrink:0` so it's always visible as a compact red icon button regardless of screen width.

### Files changed this session: `index.html`, `sw.js`
- `index.html` new checksum: `701f1f37ee1a086a84ec847157c35fdf`
- `sync-engine.js`: unchanged (`88330882b8b9ce4abcdda57b56e05520`)
- `sw.js`: `CACHE_NAME` bumped `finplan-v23` → `finplan-v24` (index.html changed — mandatory per Bug 15).
