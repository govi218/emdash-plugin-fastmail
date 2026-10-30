import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPluginRuntimeTestHost,
  type PluginRuntimeTestHost,
} from "@emdash-cms/plugin-test";

const SESSION_URL = "https://api.fastmail.com/jmap/session";
const API_URL = "https://api.fastmail.com/jmap/api/";
const message = {
  to: "a@example.org",
  subject: "Hi",
  text: "plain",
  html: "<b>rich</b>",
};

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
  vi.unstubAllEnvs();
});

const json = (body: unknown) => new Response(JSON.stringify(body));

const session = {
  apiUrl: API_URL,
  primaryAccounts: {
    "urn:ietf:params:jmap:mail": "A1",
    "urn:ietf:params:jmap:submission": "A1",
  },
};

const lookup = (identities = [{ id: "I1", email: "team@example.com" }]) => ({
  methodResponses: [
    ["Identity/get", { list: identities }, "identities"],
    [
      "Mailbox/get",
      {
        list: [
          { id: "D", role: "drafts" },
          { id: "S", role: "sent" },
        ],
      },
      "mailboxes",
    ],
  ],
});

const sent = {
  methodResponses: [
    ["Email/set", { created: { draft: { id: "E1" } } }, "email"],
    [
      "EmailSubmission/set",
      { created: { send: { id: "Sub1" } } },
      "submission",
    ],
    ["Email/set", { updated: { E1: null } }, "submission"],
  ],
};

async function setup(settings: Record<string, unknown> = {}) {
  host = await createPluginRuntimeTestHost();
  await host.fixtures.plugin.setting("apiToken", "tok");
  await host.fixtures.plugin.setting("fromEmail", "team@example.com");
  for (const [key, value] of Object.entries(settings)) {
    await host.fixtures.plugin.setting(key, value);
  }
  return host;
}

const body = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

describe("email:deliver", () => {
  it("creates the message and submits it in one request", async () => {
    const h = await setup({ fromName: "Team" });
    await h.http.respond(SESSION_URL, json(session));
    await h.http.respond(API_URL, json(lookup()));
    await h.http.respond(API_URL, json(sent));

    await h.transport.invokeHook("email:deliver", { message, source: "test" });

    const requests = h.http.requests();
    expect(requests.map((request) => request.url)).toEqual([
      SESSION_URL,
      API_URL,
      API_URL,
    ]);
    expect(
      requests[0]!.headers.authorization ?? requests[0]!.headers.Authorization,
    ).toBe("Bearer tok");

    const [create, submit] = body(requests[2]!.body).methodCalls;
    const draft = create[1].create.draft;
    expect(draft.mailboxIds).toEqual({ D: true });
    expect(draft.from).toEqual([{ email: "team@example.com", name: "Team" }]);
    expect(draft.to).toEqual([{ email: "a@example.org" }]);
    expect(draft.bodyValues).toEqual({
      text: { value: "plain" },
      html: { value: "<b>rich</b>" },
    });
    expect(submit[1].create.send).toEqual({
      emailId: "#draft",
      identityId: "I1",
    });
    expect(submit[1].onSuccessUpdateEmail["#send"]).toEqual({
      "mailboxIds/D": null,
      "mailboxIds/S": true,
      "keywords/$draft": null,
    });
  });

  it("calls the regional API host named by the session", async () => {
    const regionalApiUrl = "https://phl.api.fastmail.com/jmap/api/";
    const h = await setup();
    await h.http.respond(
      SESSION_URL,
      json({ ...session, apiUrl: regionalApiUrl }),
    );
    await h.http.respond(regionalApiUrl, json(lookup()));
    await h.http.respond(regionalApiUrl, json(sent));

    await h.transport.invokeHook("email:deliver", { message, source: "test" });

    expect(h.http.requests().map((request) => request.url)).toEqual([
      SESSION_URL,
      regionalApiUrl,
      regionalApiUrl,
    ]);
  });

  it("stores the API token encrypted and sends it decrypted", async () => {
    vi.stubEnv("EMDASH_ENCRYPTION_KEY", `emdash_enc_v1_${"A".repeat(43)}`);
    const h = (host = await createPluginRuntimeTestHost());
    const update = await h.actions.plugin.updateSettings({
      apiToken: "secret-token",
      fromEmail: "team@example.com",
    });
    expect(update.success).toBe(true);

    const raw = await h.inspect.settings.raw("apiToken");
    expect(raw).toMatchObject({ $emdash: "plugin-setting" });
    expect(JSON.stringify(raw)).not.toContain("secret-token");

    await h.http.respond(SESSION_URL, json(session));
    await h.http.respond(API_URL, json(lookup()));
    await h.http.respond(API_URL, json(sent));

    await h.transport.invokeHook("email:deliver", { message, source: "test" });

    const [request] = h.http.requests();
    expect(
      request!.headers.authorization ?? request!.headers.Authorization,
    ).toBe("Bearer secret-token");
  });

  it("accepts a wildcard identity", async () => {
    const h = await setup();
    await h.http.respond(SESSION_URL, json(session));
    await h.http.respond(
      API_URL,
      json(lookup([{ id: "W", email: "*@example.com" }])),
    );
    await h.http.respond(API_URL, json(sent));

    await h.transport.invokeHook("email:deliver", { message, source: "test" });

    const [, submit] = body(h.http.requests()[2]!.body).methodCalls;
    expect(submit[1].create.send.identityId).toBe("W");
  });

  it("rejects a From address that is not an identity", async () => {
    const h = await setup({ fromEmail: "other@elsewhere.com" });
    await h.http.respond(SESSION_URL, json(session));
    await h.http.respond(API_URL, json(lookup()));

    await expect(
      h.transport.invokeHook("email:deliver", { message, source: "test" }),
    ).rejects.toThrow("not a sending identity");
  });

  it("reports a message that could not be created", async () => {
    const h = await setup();
    await h.http.respond(SESSION_URL, json(session));
    await h.http.respond(API_URL, json(lookup()));
    await h.http.respond(
      API_URL,
      json({
        methodResponses: [
          [
            "Email/set",
            { notCreated: { draft: { type: "overQuota" } } },
            "email",
          ],
          [
            "EmailSubmission/set",
            { notCreated: { send: { type: "invalidProperties" } } },
            "submission",
          ],
        ],
      }),
    );

    await expect(
      h.transport.invokeHook("email:deliver", { message, source: "test" }),
    ).rejects.toThrow("Could not create the message");
  });

  it("reports a rejected submission", async () => {
    const h = await setup();
    await h.http.respond(SESSION_URL, json(session));
    await h.http.respond(API_URL, json(lookup()));
    await h.http.respond(
      API_URL,
      json({
        methodResponses: [
          ["Email/set", { created: { draft: { id: "E1" } } }, "email"],
          [
            "EmailSubmission/set",
            { notCreated: { send: { type: "forbiddenFrom" } } },
            "submission",
          ],
        ],
      }),
    );

    await expect(
      h.transport.invokeHook("email:deliver", { message, source: "test" }),
    ).rejects.toThrow("forbiddenFrom");
  });

  it("includes JMAP problem details in an HTTP error", async () => {
    const h = await setup();
    await h.http.respond(SESSION_URL, json(session));
    await h.http.respond(
      API_URL,
      new Response(
        JSON.stringify({
          type: "urn:ietf:params:jmap:error:unknownCapability",
          status: 400,
          detail: "Unknown capability",
        }),
        { status: 400 },
      ),
    );

    await expect(
      h.transport.invokeHook("email:deliver", { message, source: "test" }),
    ).rejects.toThrow(
      `${API_URL} returned HTTP 400: urn:ietf:params:jmap:error:unknownCapability Unknown capability`,
    );
  });

  it("reports only the status when an HTTP error body is not JSON", async () => {
    const h = await setup();
    await h.http.respond(
      SESSION_URL,
      new Response("<html>nope</html>", { status: 503 }),
    );

    await expect(
      h.transport.invokeHook("email:deliver", { message, source: "test" }),
    ).rejects.toThrow(new RegExp(`${SESSION_URL} returned HTTP 503$`));
  });

  it.each([
    ["no access", {}],
    ["no submission access", { "urn:ietf:params:jmap:mail": "A1" }],
    ["no mail access", { "urn:ietf:params:jmap:submission": "A1" }],
    [
      "different accounts",
      {
        "urn:ietf:params:jmap:mail": "A1",
        "urn:ietf:params:jmap:submission": "A2",
      },
    ],
  ])("explains a token with %s", async (_, primaryAccounts) => {
    const h = await setup();
    await h.http.respond(
      SESSION_URL,
      json({ apiUrl: API_URL, primaryAccounts }),
    );

    await expect(
      h.transport.invokeHook("email:deliver", { message, source: "test" }),
    ).rejects.toThrow("needs both Email and Email submission access");
  });
});
