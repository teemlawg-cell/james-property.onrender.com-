# James Property MNG — Start here

This guide starts the website on your computer and creates your private owner account. You do not need to edit code or install extra packages.

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
5. Start the website by entering:

   ```powershell
   npm.cmd start
   ```

6. Leave that PowerShell window open while using the website. Open `http://127.0.0.1:3000` in your browser. **Do not open `index.html` directly**; the secure website needs the server running.
7. Click the small three-dot icon in the website footer five times within ten seconds to open the owner sign-in page. You can also open `http://127.0.0.1:3000/#manage` directly.
8. On the first visit, the owner setup form is available only from this computer. Confirm the admin email, create a private password of at least 14 characters, confirm it, and select **Create secure admin account**. Save the password in your own password manager.
9. The account is then created once. From now on, use the email and password on the owner sign-in form. Public visitors cannot create an account. The server allows five failed sign-in attempts per 15 minutes from the same address.

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
- Listing information and uploaded photographs are stored in the server's `data` folder. The browser never stores the admin session in local storage.
- The server binds to this computer only by default. First-time account creation is available only from this computer and is disabled after the first account is created.

Keep the `data` folder private; it contains your property database and private account hash. The database is excluded from Git. Back up the **Download a backup** JSON and separately include the uploaded photos or the full `data` folder in your private computer backup.

## Prepare and deploy to Render

The repository includes a Render Blueprint at `render.yaml` for a Node.js web service with HTTPS, health checks, and a persistent 1 GB disk mounted at `/var/data`. Use Render's included `onrender.com` address; no custom domain registration or DNS changes are needed. Render's published pricing currently lists the configured web service at $7/month and SSD storage at $0.25/GB/month, for an estimated base of about $7.25/month with this 1 GB disk. Prices and additional usage charges can change, so review Render's current pricing and account estimate before creating the service. The user has authorized this approximate base hosting plan, but no service has been created. The disk is attached to one service instance, so do not increase the instance count. Persistent disks also mean deploys can briefly interrupt the website.

1. Create a **private** GitHub repository and publish the website source to it. Do not add `.env` files, the `data` folder, the SQLite database, or uploaded owner photos. The `.gitignore` file excludes private runtime data.
2. In Render, select **New > Blueprint**, connect the private repository, and review `render.yaml` and the account's cost estimate. Create only the configured single service and 1 GB persistent disk; do not add paid services or extra instances.
3. Wait for the first deploy to pass its `/healthz` check. A new production database is initialized with illustrative starter listings; it does not contain your local owner account, database edits, or uploads.
4. In the service's private Shell, create the owner account with `npm run setup:admin -- jamespropertymng@gmail.com`. Type a unique 14–128 character password only in the private terminal prompts. Do not set the password as an environment variable. Use `npm run reset:admin -- jamespropertymng@gmail.com` in the private Shell if it ever needs to be changed.
5. Open the service's **Settings** and copy the exact free `onrender.com` hostname assigned by Render. Confirm that it matches the expected `james-property-mng.onrender.com`; use Render's displayed hostname if it differs. Set `PUBLIC_URL` to that full HTTPS address and redeploy so canonical links and the sitemap use the live URL. Render provides HTTPS for its service hostname.
6. Open the HTTPS website, sign in, replace illustrative listings with real, owner-approved homes and photos, and verify that edits remain after a deploy. Leave search indexing disabled while examples remain. Each listing's search-indexing checkbox is an owner attestation that its details and rent are verified. Only after all public content is ready, change Render's `SEO_INDEXING_ENABLED` environment variable to `true` and redeploy. Regularly download a listings backup and separately back up the persistent disk, which includes uploaded photos.
7. Once the service hostname is live and the site is ready to be public, open [Google Search Console](https://search.google.com/search-console/) and add a **URL-prefix property** using the exact HTTPS `onrender.com` address. Select a verification method available for that hosted address. Submit the sitemap at `<PUBLIC_URL>/sitemap.xml`. Use URL Inspection on the homepage and verified property pages to request crawling; review Page indexing and Core Web Vitals reports over time. Verification, submission, and requests do not guarantee crawling, indexing, rankings, or a particular performance score.

Render sets `PORT`; this service binds to `0.0.0.0`, stores the SQLite database and uploaded photos under `/var/data`, and requires HTTPS outside its health check. The hosting proxy must forward `X-Forwarded-Proto: https`. The service is designed for one instance because sessions are held in memory and SQLite/photo storage use the persistent disk.

No Render service has been created, and the free Render hostname is not active until the service is created. No custom domain has been purchased and no DNS records have been changed. Contact email, phone, and Instagram links shown to visitors use the details supplied for this project.

## Search visibility safeguards

Production search indexing is disabled by default. The site returns `noindex` metadata until the `SEO_INDEXING_ENABLED=true` environment variable is intentionally set in production. Even then, available property pages and sitemap entries are eligible only when the owner selects the listing's **verified details and approve indexing** checkbox. The site generates property-specific titles, canonical URLs, Open Graph details, and rental structured data from the saved listing. Review every price, location, availability status, photo, and description before enabling this. Removed properties return 404; paused properties remain viewable but say they are unavailable and are excluded from indexing and the sitemap.

The sitemap is intentionally empty while indexing is disabled. The homepage and property URLs use `PUBLIC_URL` for canonical links, so set it to the exact HTTPS Render hostname before enabling indexing. Admin pages and admin API responses are marked `noindex`; `robots.txt` also blocks crawling while production indexing is disabled.

## Technical checks

Run the server checks from PowerShell in the project folder:

```powershell
npm.cmd test
```
