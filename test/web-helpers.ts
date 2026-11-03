// Drives the local app the way a browser would, without opening a network port.
import type { Database, MemoryNetContext } from "../src/index.ts";
import { createApp, type App } from "../src/web/app.ts";
import { APP_PORT } from "../src/web/kit.ts";

export const ORIGIN = `http://localhost:${APP_PORT}`;

export interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type Fields = Record<string, string | readonly string[]>;

function encode(fields: Fields): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of typeof value === "string" ? [value] : value) {
      params.append(name, item);
    }
  }
  return params.toString();
}

const CSRF = /name="_csrf"\s+value="([^"]*)"/;
const SYSTEM = /name="_system"\s+value="([^"]*)"/;

/** Keeps the session cookie and sends back the token from the last page, like a browser form would. */
export class TestBrowser {
  readonly #app: App;
  #cookie: string | null = null;
  #csrf = "";

  constructor(app: App) {
    this.#app = app;
  }

  async request(
    method: "GET" | "POST",
    path: string,
    options: {
      body?: string;
      headers?: Record<string, string | undefined>;
    } = {},
  ): Promise<Reply> {
    const url = new URL(path, ORIGIN);
    const reply = await this.#app({
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: {
        host: `localhost:${APP_PORT}`,
        ...(this.#cookie ? { cookie: this.#cookie } : {}),
        ...(method === "POST" ? { origin: ORIGIN } : {}),
        ...options.headers,
      },
      body: options.body ?? "",
    });
    const setCookie = reply.headers["Set-Cookie"];
    if (setCookie) {
      const pair = setCookie.split(";")[0] ?? "";
      this.#cookie = pair.endsWith("=") ? null : pair;
    }
    const token = CSRF.exec(reply.body)?.[1];
    if (token !== undefined && token !== "") this.#csrf = token;
    return reply;
  }

  get(path: string): Promise<Reply> {
    return this.request("GET", path);
  }

  /** Posts a form with the page token, unless the fields name their own. */
  post(
    path: string,
    fields: Fields = {},
    headers?: Record<string, string | undefined>,
  ): Promise<Reply> {
    return this.request("POST", path, {
      body: encode({ _csrf: this.#csrf, ...fields }),
      headers,
    });
  }

  /** Posts a System page form, reading its token from the System page first. */
  async system(path: string, fields: Fields = {}): Promise<Reply> {
    const systemPage = await this.get("/system");
    const token = SYSTEM.exec(systemPage.body)?.[1] ?? "";
    return this.request("POST", path, {
      body: encode({ _system: token, ...fields }),
    });
  }

  async signIn(principalId: string): Promise<void> {
    await this.get("/");
    const reply = await this.post("/sign-in", { principalId });
    if (reply.status !== 303)
      throw new Error(`Sign-in failed: ${reply.status}`);
    await this.get("/");
  }
}

export function openApp(ctx: MemoryNetContext): App {
  return createApp(ctx, { port: APP_PORT });
}

/** Loads the synthetic example data through the System page, as a tester would. */
export async function loadExample(app: App): Promise<void> {
  const reply = await new TestBrowser(app).system("/system/example-data");
  if (reply.status !== 303)
    throw new Error(`Example data failed: ${reply.status}`);
}

export async function idOf(
  db: Database,
  table: "organizations" | "business_units" | "projects",
  slug: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE slug = $1`,
    [slug],
  );
  if (!rows[0]) throw new Error(`No ${table} row with slug ${slug}`);
  return rows[0].id;
}

export async function personId(db: Database, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM principals WHERE display_name = $1",
    [name],
  );
  if (!rows[0]) throw new Error(`No principal named ${name}`);
  return rows[0].id;
}

/** Signs in as a named example person on a fresh browser. */
export async function as(
  app: App,
  db: Database,
  name: string,
): Promise<TestBrowser> {
  const browser = new TestBrowser(app);
  await browser.signIn(await personId(db, name));
  return browser;
}
