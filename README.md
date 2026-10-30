# emdash-plugin-fastmail

Send [EmDash CMS](https://emdashcms.com) email (magic links, invites, account
recovery) through [Fastmail](https://www.fastmail.com) using its JMAP API. It
uses HTTPS only, so it runs on Cloudflare Workers, where SMTP transports may not.

## Setup

1. In Fastmail, go to **Settings > Privacy & Security > Manage API tokens** and
   create a token with **Email** and **Email submission** access.
2. Set `EMDASH_ENCRYPTION_KEY` on your site. The token is stored as an encrypted
   plugin setting.
3. Install the plugin from the registry in the admin UI, or from npm:

   ```js
   // astro.config.mjs
   import fastmail from "emdash-plugin-fastmail";

   emdash({ sandboxed: [fastmail] });
   ```

4. In the plugin's settings, enter the API token and From address. The address
   must be a sending identity on the Fastmail account. Wildcard identities such
   as `*@example.com` work.
5. Under **Settings > Email**, select Fastmail and use **Send test email**.

## Good to know

- Sent messages are saved to the account's Sent folder. If a send fails, a draft
  can be left in Drafts.
- Fastmail is not a bulk sending service and applies per-user sending limits.
  Use this for transactional mail, not newsletters.

## Develop

```sh
pnpm install
pnpm run validate
pnpm run typecheck
pnpm run test
pnpm run build
```

Tests run through EmDash's production sandbox runner with Fastmail's API stubbed.

## Release

Bump `version` in `package.json`, including whenever `capabilities`,
`allowedHosts` or `storage` change, since installed users consented to the old
contract.

```sh
pnpm run login -- <handle>
pnpm run publish:registry   # atproto registry
pnpm publish                # npm
```

## License

MIT
