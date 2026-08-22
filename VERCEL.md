# The web app on Vercel

## Live now (temporary, expires ~60 min from creation)

  https://temporary-rushing-silicon-azum0yz.vercel.app

  Claim it:
  https://vercel.com/claim-deployment?code=5c221c4c-8600-4218-8583-7b42e814c402

## Why the hostname is a random string

It is an ANONYMOUS deployment. A Vercel hostname comes from the PROJECT name, and
only an account owner can create a project — so with no account attached, Vercel
generates a random name and gives it a 60-minute life. The ugly name and the expiry
are the same fact, not two problems.

`--name hellooscar-webapp` is ignored on an anonymous deploy. Verified by running
it: the hostname came back unchanged.

## To get hellooscar-webapp.vercel.app

Either of these, and the second one I can do unattended:

  A. CLAIM IT. Open the claim URL above; Vercel lets you name the project as you
     claim. Name it `hellooscar-webapp` and the hostname follows.

  B. GIVE ME A TOKEN. vercel.com → Settings → Tokens → Create. Then:

         cd ~/Desktop/Hello_Oscar/web
         VERCEL_TOKEN=… npx vercel deploy --prod --yes dist

     With a token I can create the project properly named and redeploy on demand.
     `vercel login` itself needs an interactive browser, which a non-interactive
     session cannot do — a token is the only way around that.

## Before the deployed page can talk to the backend

One CORS entry. Measured against production:

    OPTIONS /tasks/498   Origin: https://<anything>.vercel.app   -> 400
    OPTIONS /tasks/498   Origin: http://localhost:5174           -> 400

So CORS_ORIGINS on Developement_BRANCH does not include the Vercel origin (nor
5174). Until it does, the page loads and every request fails preflight — the app
says so explicitly rather than showing an empty screen.

🔴 I will not set CORS_ORIGINS blind. The Render API can WRITE env vars but not
READ them, and writing a key replaces its whole value — so I would silently delete
origins I cannot see, including the admin console. Send me its current value and I
will extend it.

## SPA rewrite

dist/vercel.json rewrites everything to /index.html. Without it a refresh on any
path 404s. The app uses a hash router, so this is belt-and-braces rather than
strictly required.
