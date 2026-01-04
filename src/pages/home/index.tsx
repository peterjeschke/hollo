import { Hono } from "hono";
import { Layout } from "../../components/Layout.tsx";
import db from "../../db.ts";
import { and, desc, eq, or } from "drizzle-orm";
import { Post as PostView } from "../../components/Post.tsx";
import {
  accountOwners,
  posts,
} from "../../schema.ts";

const homePage = new Hono().basePath("/");

homePage.get("/", async (c) => {
  if (
    "HOME_URL" in process.env &&
    // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
    process.env["HOME_URL"] != null &&
    // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
    process.env["HOME_URL"].trim() !== ""
  ) {
    // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
    return c.redirect(process.env["HOME_URL"]);
  }
  const owner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.handle, "peter"),
    with: { account: true },
  });
  if (owner == null) return c.notFound();
  const blogList = await db.query.posts.findMany({
    where: and(
      eq(posts.accountId, owner.id),
      or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
      eq(posts.type, "Article")
    ),
    orderBy: desc(posts.id),
    limit: 50,
    with: {
      account: true,
      media: true,
      poll: { with: { options: true } },
      sharing: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: true } },
          quoteTarget: {
            with: {
              account: true,
              media: true,
              poll: { with: { options: true } },
              replyTarget: { with: { account: true } },
              reactions: true,
            },
          },
          reactions: true,
        },
      },
      replyTarget: { with: { account: true } },
      quoteTarget: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: true } },
          reactions: true,
        },
      },
      reactions: true,
    },
  });
  const postList = await db.query.posts.findMany({
    where: and(
      eq(posts.accountId, owner.id),
      or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
      or(eq(posts.type, "Note"), eq(posts.type, "Question"))
    ),
    orderBy: desc(posts.id),
    limit: 50,
    with: {
      account: true,
      media: true,
      poll: { with: { options: true } },
      sharing: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: true } },
          quoteTarget: {
            with: {
              account: true,
              media: true,
              poll: { with: { options: true } },
              replyTarget: { with: { account: true } },
              reactions: true,
            },
          },
          reactions: true,
        },
      },
      replyTarget: { with: { account: true } },
      quoteTarget: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: true } },
          reactions: true,
        },
      },
      reactions: true,
    },
  });

  return c.html(
    <Layout title="Peter Jeschke">
      <h1>Peter Jeschke</h1>
      <section>
        <h2>About</h2>
        <p>Not much yet</p>
        <p>This is actually a Mastodon-compatible site in the fediverse. You can follow me at <span style="user-select: all;">@peter@jeschke.dev</span> or just read my most recent posts here:</p>
      </section>
      <div class="grid">
        <section>
          <h2><a href="/blog">Blog</a></h2>
          {blogList.map((post) => (
            <PostView post={post} />
          ))}
        </section>
        <section>
          <h2><a href="/@peter">Toots</a></h2>
          {postList.map((post) => (
            <PostView post={post} />
          ))}
        </section>
      </div>
    </Layout>,
  );
});

export default homePage;
