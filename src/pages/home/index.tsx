import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import xss from "xss";

import { Layout } from "../../components/Layout.tsx";
import { Post as PostView } from "../../components/Post.tsx";
import { SiteHeader } from "../../components/SiteHeader.tsx";
import db from "../../db.ts";

const logger = getLogger(["hollo", "home"]);
const homePage = new Hono().basePath("/");

homePage.get("/", async (c) => {
  logger.info("GET /");
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
    where: { handle: { eq: "peter" } },
    with: { account: true },
  });
  logger.info("owner: " + owner);
  if (owner == null) return c.notFound();
  const blogList = await db.query.posts.findMany({
    where: {
      accountId: owner.id,
      type: "Article",
      OR: [{ visibility: "public" }, { visibility: "unlisted" }],
    },
    orderBy: { id: "desc" },
    limit: 50,
  });
  logger.info("bloglist");
  const postList = await db.query.posts.findMany({
    where: {
      accountId: owner.id,
      sharingId: { isNull: true },
      AND: [
        {
          OR: [{ visibility: "public" }, { visibility: "unlisted" }],
        },
        {
          OR: [{ type: "Note" }, { type: "Question" }],
        },
      ],
    },
    orderBy: { id: "desc" },
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

  logger.info("postlist");
  return c.html(
    <Layout title="Peter Jeschke">
      <SiteHeader>
        <p>
          This is actually a Mastodon-compatible site in the fediverse. You
          can follow me at{" "}
          <span style="user-select: all;">@peter@jeschke.dev</span> or just
          read my most recent posts here:
        </p>
      </SiteHeader>
      <div class="grid grid-cols-2 gap-40">
        <section class="max-w-l mx-auto mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
          <h1 class="text-3xl">
            <a href="/blog">Blog</a>
          </h1>
          {blogList.map((post) => (
            <article class="py-5 flex flex-row justify-between items-baseline">
              <h2 class="font-semibold text-neutral-900 dark:text-neutral-100">
                <a href={post.url ?? post.iri}>
                  {post.summary ?? "Untitled"}
                </a>
              </h2>
              <small>
                <time
                  dateTime={(post.published ?? post.updated).toISOString()}
                >
                  {(post.published ?? post.updated).toLocaleString("en", {
                    dateStyle: "medium",
                  })}
                </time>
              </small>
            </article>
          ))}
        </section>
        <section class="max-w-l mx-auto mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
          <h1 class="text-3xl">
            <a href="/@peter">Toots</a>
          </h1>
          {postList.map((post) => (
            <PostView post={post} baseUrl={c.req.url} />
          ))}
        </section>
      </div>
    </Layout>,
  );
});

async function getOwnPostsForFeed(handle: string) {
  logger.info("=> getOwnPostsForFeed");
  const owner = await db.query.accountOwners.findFirst({
    where: { handle: { eq: handle } },
    with: { account: true },
  });
  if (owner == null) return null;
  logger.info("=> getOwnPostsForFeed: before postList");
  const postList = await db.query.posts.findMany({
    with: { account: true },
    where: {
      accountId: owner.id,
      sharingId: { isNull: true },
      AND: [
        {
          OR: [{ visibility: "public" }, { visibility: "unlisted" }],
        },
        {
          OR: [{ type: "Note" }, { type: "Question" }],
        },
      ],
    },
    orderBy: { published: "desc" },
    limit: 100,
  });
  logger.info("<= getOwnPostsForFeed");
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
            <link
              rel="alternate"
              type="text/html"
              href={post.url ?? post.iri}
            />
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
