import { Hono } from "hono";
import xss from "xss";
import { Layout } from "../../components/Layout.tsx";
import { SiteHeader } from "../../components/SiteHeader.tsx";
import db from "../../db.ts";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { Post as PostView } from "../../components/Post.tsx";
import {
  accountOwners,
  posts,
} from "../../schema.ts";

const homePage = new Hono().basePath("/");

homePage.get("/", async (c) => {
  if (
    "HOME_URL" in process.env &&
    // oxlint-disable-next-line typescript/dot-notation
    process.env["HOME_URL"] != null &&
    // oxlint-disable-next-line typescript/dot-notation
    process.env["HOME_URL"].trim() !== ""
  ) {
    // oxlint-disable-next-line typescript/dot-notation
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
  });
  const postList = await db.query.posts.findMany({
    where: and(
      eq(posts.accountId, owner.id),
      or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
      or(eq(posts.type, "Note"), eq(posts.type, "Question")),
      isNull(posts.sharingId)
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
      <SiteHeader />
      <section>
        <h2>About</h2>
        <p>Not much yet</p>
        <p>This is actually a Mastodon-compatible site in the fediverse. You can follow me at <span style="user-select: all;">@peter@jeschke.dev</span> or just read my most recent posts here:</p>
      </section>
      <div class="grid">
        <section>
          <h2><a href="/blog">Blog</a></h2>
          {blogList.map((post) => (
            <article>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <h2 style="margin: 0;">
                  <a href={post.url ?? post.iri}>{post.summary ?? "Untitled"}</a>
                </h2>
                <small>
                  <time dateTime={(post.published ?? post.updated).toISOString()}>
                    {(post.published ?? post.updated).toLocaleString("en", {
                      dateStyle: "medium",
                    })}
                  </time>
                </small>
              </div>
            </article>
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

async function getOwnPostsForFeed(handle: string) {
  const owner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.handle, handle),
    with: { account: true },
  });
  if (owner == null) return null;
  const postList = await db.query.posts.findMany({
    with: { account: true },
    where: and(
      eq(posts.accountId, owner.id),
      or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
      or(eq(posts.type, "Note"), eq(posts.type, "Question")),
      isNull(posts.sharingId),
    ),
    orderBy: desc(posts.published),
    limit: 100,
  });
  return { owner, postList };
}

homePage.get("/atom.xml", async (c) => {
  const data = await getOwnPostsForFeed("peter");
  if (data == null) return c.notFound();
  const { owner, postList } = data;
  const canonicalUrl = new URL(c.req.url);
  canonicalUrl.search = "";
  const homeUrl = new URL(c.req.url);
  homeUrl.pathname = "/";
  homeUrl.search = "";
  const response = await c.html(
    <feed xmlns="http://www.w3.org/2005/Atom">
      <id>urn:uuid:{owner.id}:posts</id>
      <title>{owner.account.name}</title>
      <link rel="self" type="application/atom+xml" href={canonicalUrl.href} />
      <link rel="alternate" type="text/html" href={homeUrl.href} />
      <author>
        <name>{owner.account.name}</name>
        <uri>{owner.account.url ?? owner.account.iri}</uri>
      </author>
      <updated>
        {(postList[0]?.updated ?? owner.account.updated).toISOString()}
      </updated>
      {postList.map((post) => {
        const title = xss(post.contentHtml ?? "", {
          allowCommentTag: false,
          whiteList: {},
          stripIgnoreTag: true,
          stripBlankChar: false,
        })
          .trimStart()
          .replace(/\r?\n.*$/, "");
        return (
          <entry>
            <id>urn:uuid:{post.id}</id>
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: xss protected */}
            <title dangerouslySetInnerHTML={{ __html: title }} />
            <link rel="alternate" type="text/html" href={post.url ?? post.iri} />
            <link
              rel="alternate"
              type="application/activity+json"
              href={post.iri}
            />
            <author>
              <name>{post.account.name}</name>
              <uri>{post.account.url ?? post.account.iri}</uri>
            </author>
            <content type="html">{post.contentHtml}</content>
            {post.published && (
              <published>{post.published.toISOString()}</published>
            )}
            <updated>{post.updated.toISOString()}</updated>
          </entry>
        );
      })}
    </feed>,
  );
  response.headers.set("Content-Type", "application/atom+xml");
  return response;
});

homePage.get("/rss.xml", async (c) => {
  const data = await getOwnPostsForFeed("peter");
  if (data == null) return c.notFound();
  const { owner, postList } = data;
  const homeUrl = new URL(c.req.url);
  homeUrl.pathname = "/";
  homeUrl.search = "";
  const response = await c.html(
    <rss version="2.0">
      <channel>
        <title>{owner.account.name}</title>
        <link>{homeUrl.href}</link>
        <description>Posts by {owner.account.name}</description>
        {postList.map((post) => {
          const title = xss(post.contentHtml ?? "", {
            allowCommentTag: false,
            whiteList: {},
            stripIgnoreTag: true,
            stripBlankChar: false,
          })
            .trimStart()
            .replace(/\r?\n.*$/, "");
          const pubDate = (post.published ?? post.updated).toUTCString();
          return (
            <item>
              <title>{title}</title>
              <link>{post.url ?? post.iri}</link>
              <guid>{`urn:uuid:${post.id}`}</guid>
              <pubDate>{pubDate}</pubDate>
              <description>{post.contentHtml}</description>
            </item>
          );
        })}
      </channel>
    </rss>,
  );
  response.headers.set("Content-Type", "application/rss+xml");
  return response;
});

export default homePage;
