# Daylight

Daylight is a static web app hosted on Netlify. Clerk provides sign-in, while Netlify Functions verify Clerk sessions and securely access task, profile, and photo data in Firebase Firestore and Storage. Firebase Authentication is not used.

## Configure services

### Clerk

1. Create a Clerk application and add its **publishable key** and **secret key** to the environment variables below.
2. In the Clerk Dashboard, enable email and password sign-in and configure Google as a social connection.
3. Add your local and deployed Daylight origins to the Clerk application's allowed origins/domains.
4. Require verified email addresses so Daylight can safely link existing Firebase profiles to Clerk accounts.

The Clerk sign-in and sign-up components follow the Clerk Dashboard's enabled methods. A user who changes their name, email, password, or connected accounts can use **Manage sign-in profile**.

### Firebase

Use the Firebase project that already contains Daylight's Firestore data and Storage bucket.

1. Create a service account for the Netlify Functions. Grant it only the access it needs: **Cloud Datastore User** for Firestore and **Storage Object Admin** for profile pictures.
2. Store the service account JSON as the `FIREBASE_SERVICE_ACCOUNT` server environment variable. Never put this credential in browser code or commit it.
3. Set `FIREBASE_STORAGE_BUCKET` to the existing bucket name. The bucket is used for Daylight profile photos.
4. Publish `firestore.rules` and `storage.rules`. Firestore client access is denied because all reads and writes go through the authenticated Netlify Function. Existing Firebase data and photo download links are retained.

On a user's first verified Clerk sign-in, the API links their Clerk ID to an existing Daylight profile with the same email address. This keeps the existing Firestore UID, tasks, profile, username, and photo references. Clerk cannot import Firebase passwords; users must create/sign into their Clerk account and verify the same email address to recover their existing data. Configure Google sign-in in Clerk separately.

## Environment variables

This is a plain JavaScript/Vite app, not Next.js. Do not use `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` here: that name is specific to Next.js. Daylight reads `CLERK_PUBLISHABLE_KEY` in its Netlify Function and provides the public value to the browser through `/api/config`; Vite does not need to expose it at build time.

Set these in **Netlify site configuration → Environment variables** for deploys, and in a local `.env` file for development. Start from `.env.example`, replace every placeholder, and never commit `.env`.

| Variable | Purpose |
| --- | --- |
| `CLERK_PUBLISHABLE_KEY` | Clerk browser key; served to the page by the public config function. This key is designed to be public. |
| `CLERK_SECRET_KEY` | Clerk server key used to verify sessions and retrieve verified account details. Keep secret. |
| `APP_ORIGINS` | Comma-separated exact origins allowed to call the API and appear in Clerk session tokens, e.g. `http://localhost:8888,https://daylight.netlify.app`. Do not include trailing slashes. Add any custom domain and deploy-preview origins you use. |
| `FIREBASE_SERVICE_ACCOUNT` | Full Firebase service-account JSON for server-side Firestore and Storage access. Keep secret. |
| `FIREBASE_STORAGE_BUCKET` | Existing Firebase Storage bucket name, e.g. `daylight-project.firebasestorage.app`. |

For local development, create a local `.env` from `.env.example`, then run:

```powershell
npm install
npx netlify-cli dev
```

Open the localhost URL printed by Netlify CLI. Netlify Functions are required for sign-in data and cloud sync; opening `index.html` directly or serving it with a basic static server will not provide those endpoints.

## Deploy to Netlify

1. Push this project to your Git provider and import it in Netlify.
2. Add the environment variables above in Netlify. Use your actual production and local origins in `APP_ORIGINS`.
3. In the Clerk Dashboard, authorize the deployed domain and configure Google OAuth for that domain.
4. Deploy. `netlify.toml` configures `npm run build`, the `dist` publish directory, and `netlify/functions`.
5. Test sign-up, Google sign-in, profile editing, photo upload, sign-out, and task sync on a second browser/device.

The page keeps local tasks and reminder settings available when signed out. Signed-in task and reminder changes sync through the Netlify API; other devices refresh account data periodically. Browser notification permission remains specific to each device/browser.
