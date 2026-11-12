# Set up your own Budget app

You need two links from the person who shared the app:
1. a **copy link** for the budget sheet (it puts your own budget workbook and script into your Google Drive)
2. the **app link**: https://mhelguero.github.io/budget/

Steps 1–5 need a computer, because the Budget app menu and Apps Script don't work in the phone apps. It takes about 10 minutes.

## Steps
1. **Copy:** open the copy link while signed into **your** Google account and click **Make a copy**. Google may mention that the script is copied too. Your own workbook opens.
2. **Passphrase:** in the menu bar, choose **Budget app → Set up / change passphrase**. If the menu isn't there, reload the page and wait a few seconds.
   - Approve the permissions: **Continue → your account → Advanced → Go to (project) (unsafe) → Allow**. The warning is normal for a personal script.
   - Type a passphrase (6+ characters) and remember it.
3. **Deploy:** choose **Extensions → Apps Script**, then the blue **Deploy → New deployment**.
   - Click the **gear** next to "Select type" and choose **Web app**.
   - Description: Budget. **Execute as: Me**. **Who has access: Anyone**.
   - Click **Deploy**, then **Authorize access** if asked (same Advanced → Allow steps).
4. **Copy the URL:** copy the **Web app URL** ending in `/exec`. It's also available any time from **Budget app → Show app link** in the sheet.
5. Send that URL to your phone, for example by email or Notes.
6. **On the iPhone:** open **https://mhelguero.github.io/budget/** in **Safari**, paste the URL, type the passphrase, then tap **Save**.
7. **Set up your budget** opens: enter your categories (up to 8) and monthly amounts, then tap **Save**.
8. **Install:** tap **Share → Add to Home Screen → Add**.
9. **Check:** add a test payment, look for it in the sheet's log (row 16), then delete it in History.

## Optional: Chase email import (for Chase card users), on the computer
10. In the Chase app or website, turn on **purchase alerts** (Account alerts → transactions over $0.00), sent to the **same Gmail** as the Google account that owns your budget copy.
11. In your budget sheet: **Budget app → Turn on Chase email import**. Approve the Gmail permission if asked: the script only **reads** emails from no.reply.alerts@chase.com and never changes or deletes mail.
12. From then on, each purchase alert becomes a payment within about 10 minutes (only emails received after turning it on).
    - Charges from stores the app doesn't know yet wait on the app's **Chase charges** card for you to pick a category. Tick **Remember this merchant** and the next charge there is filed automatically.
    - Only Chase alerts are understood. Other banks' emails are ignored.

## Optional: AI picks categories for new stores
Without this, everything still works: new stores just wait for you to pick a category once. With it, Claude picks the category for each new store.
13. Go to **console.anthropic.com** and sign up. This is separate from claude.ai, and a free claude.ai account is fine.
14. Under **Billing**, add a card and buy a small amount of credit (a few dollars). It costs about a hundredth of a cent per new store, and each store is only asked about once, so a few dollars lasts a very long time.
15. Under **API Keys**, choose **Create Key** and copy it. Keep it private.
16. In your budget sheet: **Extensions → Apps Script → gear (Project Settings) → Script Properties → Add script property**.
    Property: `ANTHROPIC_API_KEY`, Value: the key. Then **Save script properties**.

## Good to know
- **Your data stays in your own sheet.** You get app updates automatically, and nobody else sees your budget.
- **Edit categories & budgets** (bottom of Home): change amounts any time and add categories, up to 8.
  A category with payments this month can't be renamed or removed until next month, but its amount can still be changed.
  Names can't contain `* ? ~`, and one name can't be part of another (like "Gas" and "Sams Gas").
- **Changing your passphrase:** in the sheet, choose **Budget app → Set up / change passphrase** again, then in the app use **Re-enter setup**.
- **On the 1st of each month**, last month's totals are saved to an Archive tab and the payment log is cleared automatically.
- **If you're asked to update the script:** paste the new Code.gs into Extensions → Apps Script (replacing everything), save, then
  **Deploy → Manage deployments → pencil → Version: New version → Deploy**. The URL stays the same.
