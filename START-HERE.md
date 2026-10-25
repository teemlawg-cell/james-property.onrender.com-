# James Property MNG — Start here

This guide starts the website on your computer and creates your private owner account. You do not need to edit code.

## Your owner sign-in details

- **Admin email:** `jamespropertymng@gmail.com`
- **Website address on this computer:** `http://127.0.0.1:3000`
- **Owner sign-in:** Click the small three-dot icon in the website footer five times within ten seconds. The sign-in page then opens. You can also open `http://127.0.0.1:3000/#manage` directly.
- **Password:** You create your own, private password on the first visit. Use at least 14 characters. It is never put in the website files, and I have not generated or seen it.

## Start the website

1. Install Node.js 22.13 or newer if it is not already installed. The current Node.js LTS version is suitable.
2. Open the **housing website** folder in File Explorer.
3. Click the folder’s address bar, type `powershell`, and press **Enter**. A PowerShell window opens in the right folder.
4. Type `node --version` and press **Enter**. If Windows reports that Node is not found, install Node.js and reopen PowerShell.
5. Install the project packages by entering:

   ```powershell
   npm.cmd install
   ```

6. Start the website by entering:

   ```powershell
   npm.cmd start
   ```

7. Leave that PowerShell window open while using the website. Open `http://127.0.0.1:3000` in your browser. **Do not open `index.html` directly**; the secure website needs the server running.
8. Click the small three-dot icon in the website footer five times within ten seconds to open the owner sign-in page. You can also open `http://127.0.0.1:3000/#manage` directly.
9. On the first visit, the owner setup form is available only from this computer. Confirm the admin email, create a private password of at least 14 characters, confirm it, and select **Create secure admin account**. Save the password in your own password manager.
10. The account is then created once. From now on, use the email and password on the owner sign-in form. Public visitors cannot create an account. The server allows five failed sign-in attempts per 15 minutes from the same address.

**Do not share your password in chat, email, or a screenshot.** If this computer is shared, sign out of the dashboard and protect your Windows account with its own password.

## Stop and restart

- To stop the local website, focus the PowerShell window running it and press **Ctrl+C**.
- To start it again later, open PowerShell in the project folder and run `npm.cmd start`.
- Your owner account, property information, activity, and uploaded photos are kept in the `data` folder. Stopping the server does not delete them.

## Manage properties

- **Add a property:** Select **Add a home** and fill in the details. Add a main photo and up to seven more indoor photos for the living area, bedrooms, kitchen, bathroom, and amenities. Choose a label for each added view. Photos from your device are resized before saving; HTTPS photo links are also accepted.
- **Change a listing or price:** Select **Edit**, make the changes, and save.
- **Update property photos:** In the editor, uncheck any existing photo you want removed, change its view label if needed, and add replacement photos.
- **Furnished status:** Check **This home is fully furnished** only when the property is furnished. The starter collection has one furnished apartment; the other homes are shown as vacant and unfurnished.
- **Hide a listing:** Select **Pause**. Use **Publish** to show it again.
- **Remove a listing:** Select **Delete** and confirm. Download a backup first if you may need the listing again.
- **Back up:** Select **Download a backup** regularly and save the JSON file somewhere safe.
- **Restore or move older listings:** Select **Import a backup** and choose a JSON backup made by James Property MNG. Imported listings are added or updated by listing ID; other listings are not deleted.

The starter homes cover Hawthorne, Oak Park, Long Beach, San Pedro, Sacramento, Ceres, Los Angeles, and Riverside. The suggested monthly rent ranges are $800–$1,000 for one bedroom, $1,150–$1,700 for two bedrooms, and $2,000–$3,000 for three bedrooms. The one furnished two-bedroom starter listing is priced at $1,750 to reflect its furnished premium. These starter listings, locations, rents, and reference photos are illustrative—not verified offers, actual property photographs, or a market appraisal. Before publishing to renters, replace them with real, available homes, accurate prices and details, and owner-approved photographs of each property's interior.

The footer icon gesture only keeps the sign-in entrance out of the public navigation; it is not a security feature. The owner dashboard and its changes remain protected by the server-side password, session, and request checks described below.

## What is protected

- The website serves its files and API from the Node.js server; the owner password is **not** checked in the public browser code.
- The admin password must contain 14–128 characters. The server stores a salted `scrypt` password hash, not the password itself.
- Owner access uses a random, HTTP-only, SameSite session cookie with an eight-hour lifetime and a CSRF token for changes.
- On this computer, listing information and uploaded photographs are stored in the server's `data` folder. In the free hosted setup, listings and owner credentials are stored in Supabase Postgres, and uploaded photos are stored in its public photo bucket. The browser never stores the admin session in local storage.
- The server binds to this computer only by default. First-time account creation is available only from this computer and is disabled after the first account is created.

Keep the `data` folder private; it contains your property database and private account hash. The database is excluded from Git. Back up the **Download a backup** JSON and separately include the uploaded photos or the full `data` folder in your private computer backup.

## Free hosting with Render and Supabase

The Render Blueprint uses a free Node.js web service and Render's included `onrender.com` address; a custom domain is optional and costs extra. Render's free service sleeps after 15 minutes without traffic, may take about a minute to wake, and has an ephemeral filesystem. The app therefore stores listings in Supabase Postgres and photos in Supabase Storage instead of relying on Render's local disk. Supabase's current free tier includes 500 MB of database and 1 GB of file storage, but pauses projects after one week without activity. Render describes free instances as suitable for testing and hobby projects, not production. These free limits and prices may change.

1. Sign in to Supabase and create a project on the **Free** plan. Choose a US region near Render's Oregon region if available. Save the database password somewhere private; do not send it in chat.
2. In the new Supabase project, open **SQL Editor**, then run the contents of `supabase/schema.sql`. This creates the app's tables, enables row-level security, grants access only to the backend service role, and creates the public JPEG photo bucket.
3. In Supabase **Project Settings > API**, copy the project URL and the `service_role` key. Treat the service-role key as a password. Never put it in website files or GitHub.
4. Before creating the Render service, copy your existing local listings, admin account, and uploaded photos to Supabase. In PowerShell opened in the project folder, enter:

   ```powershell
   $env:SUPABASE_URL = Read-Host "Supabase project URL"
   $serviceKey = Read-Host "Supabase service-role key" -AsSecureString
   $env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new("", $serviceKey).Password
   try {
     npm.cmd run migrate:supabase
   } finally {
     Remove-Item Env:SUPABASE_URL, Env:SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
     $serviceKey.Dispose()
     Remove-Variable serviceKey -ErrorAction SilentlyContinue
   }
   ```

   The key prompt is hidden. Migration requires empty application tables in the new Supabase project and leaves your local database and photos unchanged. It copies the existing salted admin password hash, so the current owner password remains the same. Do not start the Render service until the migration has completed; its first startup seeds sample homes when the remote listings table is empty.
5. In Render, select **New > Blueprint**, connect the existing GitHub repository, and review the Blueprint. Enter the Supabase project URL and service-role key only in Render's private environment-variable prompts. Create the single free web service; do not add paid services.
6. Wait for `/healthz` to pass. The service connects to your migrated Supabase data; Render's local filesystem is not used for persistent listings or photos.
7. Open the HTTPS `onrender.com` address and sign in with your existing admin email and password. If you need to reset the password, repeat the hidden-key PowerShell setup above and run `npm.cmd run reset:admin -- jamespropertymng@gmail.com` instead of the migration command. If no admin account was migrated, run `npm.cmd run setup:admin -- jamespropertymng@gmail.com`; it prompts for a new password without saving it in the website files.
8. Replace all illustrative listings with real, owner-approved homes and photos, and test adding/editing a listing. Keep search indexing disabled until the public information has been verified.
9. For backups, regularly use **Download a backup** for listing data and separately download the Supabase Storage photos. Do not rely on free-tier services as the only copy of important business data.

The Render service uses one instance because login sessions are held in memory; a sleep, restart, or deploy signs the owner out. The Render free service hostname has not been confirmed or provisioned for this app. No hosting project, domain, or DNS changes have been made. Contact details displayed to visitors use the information supplied for this project.

## Search visibility safeguards

Production search indexing is disabled by default. The site returns `noindex` metadata until the `SEO_INDEXING_ENABLED=true` environment variable is intentionally set in production. Even then, available property pages and sitemap entries are eligible only when the owner selects the listing's **verified details and approve indexing** checkbox. The site generates property-specific titles, canonical URLs, Open Graph details, and rental structured data from the saved listing. Review every price, location, availability status, photo, and description before enabling this. Removed properties return 404; paused properties remain viewable but say they are unavailable and are excluded from indexing and the sitemap.

The sitemap is intentionally empty while indexing is disabled. The homepage and property URLs use `PUBLIC_URL` for canonical links, so set it to the exact HTTPS Render hostname before enabling indexing. Admin pages and admin API responses are marked `noindex`; `robots.txt` also blocks crawling while production indexing is disabled.

## Technical checks

Run the server checks from PowerShell in the project folder:

```powershell
npm.cmd test
```
