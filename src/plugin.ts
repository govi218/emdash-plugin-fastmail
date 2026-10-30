import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

const SESSION_URL = "https://api.fastmail.com/jmap/session";
const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";
const CAPABILITIES = [
  "urn:ietf:params:jmap:core",
  MAIL_CAPABILITY,
  SUBMISSION_CAPABILITY,
];

interface Message {
  to: string;
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
}

interface Session {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
}

type MethodResponse = [name: string, args: any, callId: string];

function fail(detail: string): never {
  throw new Error(`[fastmail] ${detail}`);
}

async function jmapFetch<T>(
  ctx: PluginContext,
  token: string,
  url: string,
  init?: { method: string; body: string },
): Promise<T> {
  const response = await ctx.http!.fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      type?: string;
      detail?: string;
    } | null;
    const details = [problem?.type, problem?.detail].filter(Boolean).join(" ");
    fail(`${url} returned HTTP ${response.status}${details && `: ${details}`}`);
  }
  return (await response.json()) as T;
}

async function call(
  ctx: PluginContext,
  token: string,
  session: Session,
  methodCalls: unknown[],
): Promise<Map<string, any>> {
  const { methodResponses } = await jmapFetch<{
    methodResponses: MethodResponse[];
  }>(ctx, token, session.apiUrl, {
    method: "POST",
    body: JSON.stringify({ using: CAPABILITIES, methodCalls }),
  });
  const results = new Map<string, any>();
  for (const [name, args, callId] of methodResponses) {
    if (name === "error")
      fail(`${callId} failed: ${args.type} ${args.description ?? ""}`);
    // EmailSubmission's onSuccessUpdateEmail adds an implicit Email/set
    // response under the same call id; keep the submission result.
    if (!results.has(callId)) results.set(callId, args);
  }
  return results;
}

function firstError(
  result: Record<string, unknown> | null | undefined,
): string | undefined {
  const error = result && Object.values(result)[0];
  return error ? JSON.stringify(error) : undefined;
}

function buildEmail(
  message: Message,
  from: { email: string; name?: string },
  mailboxId: string,
): Record<string, unknown> {
  const bodyValues: Record<string, { value: string }> = {
    text: { value: message.text },
  };
  if (message.html) bodyValues.html = { value: message.html };
  return {
    mailboxIds: { [mailboxId]: true },
    keywords: { $draft: true, $seen: true },
    from: [from],
    to: [{ email: message.to }],
    ...(message.cc?.length
      ? { cc: message.cc.map((email) => ({ email })) }
      : {}),
    ...(message.replyTo ? { replyTo: [{ email: message.replyTo }] } : {}),
    subject: message.subject,
    textBody: [{ partId: "text", type: "text/plain" }],
    ...(message.html
      ? { htmlBody: [{ partId: "html", type: "text/html" }] }
      : {}),
    bodyValues,
  };
}

// A wildcard identity like *@example.com can send from any address on the domain.
function matchesIdentity(identityEmail: string, from: string): boolean {
  const identity = identityEmail.toLowerCase();
  const address = from.toLowerCase();
  return (
    identity === address ||
    (identity.startsWith("*@") && address.endsWith(identity.slice(1)))
  );
}

const plugin: SandboxedPlugin = {
  hooks: {
    "email:deliver": {
      exclusive: true,
      handler: async ({ message }, ctx) => {
        const token = await ctx.settings.get<string>("apiToken");
        const fromEmail = await ctx.settings.get<string>("fromEmail");
        const fromName = await ctx.settings.get<string>("fromName");
        if (!token || !fromEmail)
          fail("API token and From address must be set in plugin settings");

        const session = await jmapFetch<Session>(ctx, token, SESSION_URL);
        const accountId = session.primaryAccounts[SUBMISSION_CAPABILITY];
        if (
          !accountId ||
          session.primaryAccounts[MAIL_CAPABILITY] !== accountId
        )
          fail("API token needs both Email and Email submission access");

        const lookup = await call(ctx, token, session, [
          ["Identity/get", { accountId, ids: null }, "identities"],
          [
            "Mailbox/get",
            { accountId, ids: null, properties: ["role"] },
            "mailboxes",
          ],
        ]);
        const identity = lookup
          .get("identities")
          .list.find((item: { email: string }) =>
            matchesIdentity(item.email, fromEmail),
          );
        if (!identity)
          fail(
            `${fromEmail} is not a sending identity on this Fastmail account`,
          );

        const mailboxes: { id: string; role: string | null }[] =
          lookup.get("mailboxes").list;
        const drafts = mailboxes.find((mailbox) => mailbox.role === "drafts");
        const sent = mailboxes.find((mailbox) => mailbox.role === "sent");
        if (!drafts || !sent)
          fail("Could not find the Drafts and Sent mailboxes");

        const from = {
          email: fromEmail,
          ...(fromName ? { name: fromName } : {}),
        };
        const results = await call(ctx, token, session, [
          [
            "Email/set",
            {
              accountId,
              create: { draft: buildEmail(message, from, drafts.id) },
            },
            "email",
          ],
          [
            "EmailSubmission/set",
            {
              accountId,
              create: { send: { emailId: "#draft", identityId: identity.id } },
              onSuccessUpdateEmail: {
                "#send": {
                  [`mailboxIds/${drafts.id}`]: null,
                  [`mailboxIds/${sent.id}`]: true,
                  "keywords/$draft": null,
                },
              },
            },
            "submission",
          ],
        ]);

        const emailError = firstError(results.get("email")?.notCreated);
        if (emailError) fail(`Could not create the message: ${emailError}`);
        const submissionError = firstError(
          results.get("submission")?.notCreated,
        );
        if (submissionError)
          fail(`Could not send the message: ${submissionError}`);

        ctx.log.info("email delivered via Fastmail", {
          to: message.to,
          subject: message.subject,
        });
      },
    },
  },
};

export default plugin;
