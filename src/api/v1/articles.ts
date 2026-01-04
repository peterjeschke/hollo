import { Article } from "@fedify/vocab";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { getPostRelations, serializePost } from "../../entities/status";
import federation from "../../federation";
import { updateAccountStats } from "../../federation/account";
import {
  getRecipients,
  toCreate,
  toUpdate,
} from "../../federation/post";
import { appendPostToTimelines } from "../../federation/timeline";
import { requestBody } from "../../helpers";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import { media, posts } from "../../schema";
import { isUuid, uuid, uuidv7 } from "../../uuid";
import { sanitizeHtml } from "../../xss";

const app = new Hono<{ Variables: Variables }>();

function getPostOrderingKey(postIri: string): string {
  return `post:${postIri}`;
}

const articleSchema = z.object({
  summary: z.string().min(1),
  content_html: z.string().min(1),
  language: z.string().min(2).optional(),
  sensitive: z.boolean().default(false),
  media_ids: z.array(uuid).optional(),
  visibility: z
    .enum(["public", "unlisted", "private", "direct"])
    .default("public"),
});

const updateArticleSchema = z.object({
  summary: z.string().min(1).optional(),
  content_html: z.string().min(1).optional(),
  language: z.string().min(2).optional(),
  sensitive: z.boolean().optional(),
  visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
});

app.post("/", tokenRequired, scopeRequired(["write:statuses"]), async (c) => {
  const token = c.get("token");
  const owner = token.accountOwner;
  if (owner == null) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }

  const result = await requestBody(c.req, articleSchema);
  if (!result.success) {
    return c.json({ error: "invalid_request", zod_error: result.error }, 422);
  }

  const data = result.data;
  const handle = owner.handle;
  const id = uuidv7();

  const fedCtx = federation.createContext(c.req.raw, undefined);
  const iri = fedCtx.getObjectUri(Article, { username: handle, id });
  const baseUrl = new URL(c.req.url);
  baseUrl.pathname = "";
  baseUrl.search = "";
  const canonicalUrl = new URL(`/blog/${id}`, baseUrl).href;
  const contentHtml = sanitizeHtml(data.content_html);

  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(posts)
      .values({
        id,
        iri: iri.href,
        type: "Article",
        accountId: owner.id,
        applicationId: token.applicationId,
        visibility: data.visibility,
        summary: data.summary,
        content: contentHtml,
        contentHtml,
        language: data.language ?? owner.language,
        sensitive: data.sensitive,
        url: canonicalUrl,
        published: new Date(),
        tags: {},
        emojis: {},
      })
      .returning();

    if (data.media_ids != null && data.media_ids.length > 0) {
      for (const mediaId of data.media_ids) {
        const result = await tx
          .update(media)
          .set({ postId: id })
          .where(and(eq(media.id, mediaId), isNull(media.postId)))
          .returning();
        if (result.length < 1) {
          tx.rollback();
          return;
        }
      }
    }

    await updateAccountStats(tx, owner);
    await appendPostToTimelines(tx, {
      ...inserted,
      sharing: null,
      mentions: [],
      replyTarget: null,
    });
  });

  const post = await db.query.posts.findFirst({
    where: eq(posts.id, id),
    with: getPostRelations(owner.id),
  });
  if (post == null) return c.json({ error: "Internal server error" }, 500);

  const activity = toCreate(post, fedCtx);
  const orderingKey = getPostOrderingKey(post.iri);
  await fedCtx.sendActivity(
    { username: handle },
    getRecipients(post),
    activity,
    {
      orderingKey,
      excludeBaseUris: [new URL(c.req.url)],
    },
  );
  if (post.visibility !== "direct") {
    await fedCtx.sendActivity({ username: handle }, "followers", activity, {
      orderingKey,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(c.req.url)],
    });
  }

  return c.json(serializePost(post, owner, c.req.url));
});

app.patch(
  "/:id",
  tokenRequired,
  scopeRequired(["write:statuses"]),
  async (c) => {
    const token = c.get("token");
    const owner = token.accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }

    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: "Record not found" }, 404);
    }

    const existing = await db.query.posts.findFirst({
      where: and(eq(posts.id, id), eq(posts.accountId, owner.account.id)),
    });
    if (existing == null) {
      return c.json({ error: "Record not found" }, 404);
    }
    if (existing.type !== "Article") {
      return c.json({ error: "Not an article" }, 422);
    }

    const result = await requestBody(c.req, updateArticleSchema);
    if (!result.success) {
      return c.json({ error: "invalid_request", zod_error: result.error }, 422);
    }

    const data = result.data;
    if (Object.values(data).every((v) => v === undefined)) {
      const post = await db.query.posts.findFirst({
        where: eq(posts.id, id),
        with: getPostRelations(owner.id),
      });
      if (post == null) return c.json({ error: "Record not found" }, 404);
      return c.json(serializePost(post, owner, c.req.url));
    }

    const contentHtml =
      data.content_html != null ? sanitizeHtml(data.content_html) : undefined;

    await db.transaction(async (tx) => {
      await tx
        .update(posts)
        .set({
          ...(data.summary != null ? { summary: data.summary } : {}),
          ...(contentHtml != null
            ? { content: contentHtml, contentHtml }
            : {}),
          ...(data.language != null ? { language: data.language } : {}),
          ...(data.sensitive != null ? { sensitive: data.sensitive } : {}),
          ...(data.visibility != null ? { visibility: data.visibility } : {}),
          updated: new Date(),
        })
        .where(eq(posts.id, id));
    });

    const fedCtx = federation.createContext(c.req.raw, undefined);

    const post = await db.query.posts.findFirst({
      where: eq(posts.id, id),
      with: getPostRelations(owner.id),
    });
    if (post == null) return c.json({ error: "Internal server error" }, 500);

    const activity = toUpdate(post, fedCtx);
    const orderingKey = getPostOrderingKey(post.iri);
    await fedCtx.sendActivity(
      { username: owner.handle },
      getRecipients(post),
      activity,
      {
        orderingKey,
        excludeBaseUris: [new URL(c.req.url)],
      },
    );
    if (post.visibility !== "direct") {
      await fedCtx.sendActivity(
        { username: owner.handle },
        "followers",
        activity,
        {
          orderingKey,
          preferSharedInbox: true,
          excludeBaseUris: [new URL(c.req.url)],
        },
      );
    }

    return c.json(serializePost(post, owner, c.req.url));
  },
);

export default app;
