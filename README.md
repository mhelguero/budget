# Budget

A phone budget app (a PWA) backed by your own Google Sheet.

- **App:** https://mhelguero.github.io/budget/ (served by GitHub Pages from `main`; add it to the home screen on Android or iPhone)
- **New user?** Follow [SETUP.md](SETUP.md).

## How it fits together
```
phone app (index.html)  ──HTTPS──▶  Google Apps Script web app (backend/Code.gs)  ──▶  your Google Sheet
   stores the /exec URL + passphrase           bound to the sheet; checks the passphrase           categories, budgets, payment log,
   on the phone only (localStorage)            (Script Property SECRET)                            archive, trip, Chase imports
```
- The app holds no budget data. Each person's phone talks to **their own** sheet's script.
- No secrets live in this repo. Per-sheet settings are **Script Properties** in that sheet's Apps Script project.

## Files
| File | What it is |
|---|---|
| `index.html` | The whole app: HTML, CSS and JS. No build step, no dependencies. |
| `sw.js` | Service worker: network-first, with an offline copy. |
| `manifest.json`, `icon-*.png` | Home-screen install info. |
| `backend/Code.gs` | The Apps Script backend. Paste it into the sheet's **Extensions → Apps Script**. |
| `SETUP.md` | Step-by-step setup for a new user (copy the template sheet, deploy, connect the app). |

## The sheet layout the backend expects
Tab **"Am I over Budget??"** (found by name, or by gid 848641762):
- **Categories:** rows 6–13. Name in column **B**, monthly budget in **C**, spent in **D** (formula
  `=IF(B6 = "", "",(SUMIF($C$16:$C$86,"*"& B6 & "*",$D$16:$D$86)))`). There's room for 8 categories.
- **Total row:** right after the categories (row 14), with "Total" in column B. Budget `=SUM(C6:C13)` (plus anything extra), spent `=SUM(D6:D13)`.
- **Payment log:** row 16 down. Date **B** (blank means same day as the row above), Category **C**, Amount **D**, Note **E**. The Spending formulas only count rows 16–86.

Other tabs are created by the script when needed: `Archive YYYY`, `Savings Owed`, `Bolivia Trip`, `Merchant Rules`, `Chase Imports`.

## Script Properties (per sheet, in Apps Script → Project Settings)
| Property | Set by | Meaning |
|---|---|---|
| `SECRET` | Budget app → Set up | The passphrase the app sends |
| `SHEET_ID` | Budget app → Set up | Fallback if the active spreadsheet isn't available |
| `NEEDS_BUDGET` | Set up, on a fresh copy | Makes the app show "Set up your budget" once |
| `lastArchived` | monthly job | Last month archived (`yyyy-MM`) |
| `chaseStart` | Turn on Chase email import | Only emails after this time are imported |
| `ANTHROPIC_API_KEY` | you (optional) | Claude key for AI categorizing of unknown merchants |
| `AI_HINTS` | you (optional) | JSON `{"category": "what it covers"}` to help the AI choose |
| `TRIP_SKIP` | you (optional) | `yyyy-mm-dd..yyyy-mm-dd`: Chase charges in this window are ignored |
| `ai\|KEYWORD` | AI | Cached AI answer per merchant |

## Backend API (what the app calls)
GET `<exec>?key=PASS[&action=...]`
- *(no action)* → `{version, categories:[{name,budget,spent}], total:{budget,spent}, owed, pendingCount, recentImports, aiRecent, maxCategories, needsBudget}`
- `payments` → `{payments:[{row, date, effectiveDate, category, amount, note}], lastRow, limitWarning}`
- `summary` → `{year, current, months, rows:[{name, values:{Mon:amt}, yearTotal, startingTotal}], totals}`
- `imports`, `rules`, `owed`, `trip`, `ping`

POST JSON `{key, action, ...}`, where action is one of `add` (default, `items:[...]`), `update`, `delete`, `budgetSave`, `ruleSave`, `ruleDelete`,
`importSet`, `importSkip`, `owedAdd`, `owedDelete` or `tripSave`. Errors come back as `{error: "..."}`.

## Making changes
1. Work on `main`.
2. Every app release bumps **both** `const APP_VERSION = N` in `index.html` and `const CACHE = 'budget-vN'` in `sw.js`. Commit as `Update app to vN: ...`.
3. Test before pushing:
   - Serve the folder (`python3 -m http.server`) and drive it with Playwright using a phone profile (for example Pixel 7).
   - Mock `https://script.google.com/**` with JSON shaped like the API above.
   - Don't use `file://`: localStorage doesn't persist there.
4. After a push, phones pick up the update when the app is closed and reopened (network-first service worker).
5. Changes to `backend/Code.gs` only take effect once each sheet owner pastes the new code and chooses **Deploy → Manage deployments → New version**.
   Bump `API_VERSION` in Code.gs when the backend changes.
