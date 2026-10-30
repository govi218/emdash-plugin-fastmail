# emdash-plugin-fastmail

Send [EmDash CMS](https://emdashcms.com) email (magic links, invites, account
recovery) through [Fastmail](https://www.fastmail.com) using its JMAP API. It
uses HTTPS only, so it runs on Cloudflare Workers, where SMTP transports may not.

## Setup

- In Fastmail, go to **Settings > Privacy & Security > Manage API tokens** and
  create a token with **Email** and **Email submission** access.
- Set `EMDASH_ENCRYPTION_KEY` on your site, if you haven't already. The token is stored as an encrypted
  plugin setting.
- Install the plugin from the registry in the admin UI, or from npm:

  ```js
  // astro.config.mjs
  import fastmail from "emdash-plugin-fastmail";

  emdash({ sandboxed: [fastmail] });
  ```

- In the plugin's settings, enter the API token and From address. The address
  must be a sending identity on the Fastmail account. Wildcard identities such
  as `*@example.com` work.
- Under **Settings > Email**, use **Send test email**. Fastmail is selected
  automatically when it's the only email provider. If the send fails, the
  error will be in the server logs.

The site needs a sandbox runner, such as `sandbox()` from
`@emdash-cms/cloudflare`, to load the plugin.

### Local development

- Build the plugin and install it in the site:

  ```sh
  cd emdash-plugin-fastmail && pnpm run build
  cd /path/to/your/emdash/site && pnpm add file:/path/to/emdash-plugin-fastmail
  ```

- Register it in the site's `astro.config.mjs`, as in the setup above
- Start the site with `pnpm dev`

After modifying the plugin, rebuild and install as above and restart the dev server. Hot reload
doesn't pick up plugin changes, because the site uses a copy and EmDash caches the
loaded plugin (make sure not to commit the `file:` dependency in the site repo).

In `astro dev`, EmDash also registers a console email provider
(`emdash-console-email`). With two providers, nothing is selected automatically,
so **Settings > Email** says "No email provider configured" even though the
plugin has loaded. The page has no selector, so select Fastmail through the admin
API. The choice is saved in the local database, so you only need to do this once.

With the dev server running on port 4321:

```sh
BASE=http://localhost:4321/_emdash/api
COOKIES=$(mktemp)

# 1. Sign in as the dev admin and save the session cookie. This route only works
#    in dev mode, and creates the dev@emdash.local admin if it doesn't exist.
curl -s -o /dev/null -c "$COOKIES" \
  "$BASE/auth/dev-bypass?redirect=/_emdash/admin"

# 2. Select Fastmail as the email provider.
curl -s -b "$COOKIES" -X PUT \
  -H "X-EmDash-Request: 1" \
  -H "Content-Type: application/json" \
  -d '{"pluginId":"fastmail"}' \
  "$BASE/admin/hooks/exclusive/email:deliver"

# 3. Check the result: expect "selectedProviderId":"fastmail".
curl -s -b "$COOKIES" -H "X-EmDash-Request: 1" "$BASE/settings/email"

# 4. Delete the saved session.
rm -f "$COOKIES"
```

Refresh **Settings > Email**, and the test email form should appear.

The following commands are available for development:

```sh
pnpm install
pnpm run validate
pnpm run typecheck
pnpm run test
pnpm run build
```

Tests run through EmDash's production sandbox runner with Fastmail's API stubbed.

## Misc

- Sent messages are saved to the account's Sent folder, including any magic or
  recovery links they contain. If a send fails, a draft with the same content
  can be left in Drafts.
- Fastmail is not a bulk sending service and applies per-user sending limits.
  Use this for transactional mail, not newsletters.

## License

MIT
