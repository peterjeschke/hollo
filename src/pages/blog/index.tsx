import { and, count, desc, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import xss from "xss";
import { Layout } from "../../components/Layout.tsx";
import { Post as PostView } from "../../components/Post.tsx";
import { db } from "../../db.ts";
import {
  type Account,
  type Medium,
  type Poll,
  type PollOption,
  type Post,
  type Reaction,
  accountOwners,
  posts,
} from "../../schema.ts";
import { isUuid } from "../../uuid.ts";
import blogPost from "./blogPost.tsx";

const blog = new Hono();

blog.route("/:id{[-a-f0-9]+}", blogPost);

const PAGE_SIZE = 30;

blog.get(async (c) => {
  const owner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.handle, "peter"),
    with: { account: true },
  });
  if (owner == null) return c.notFound();
  const contStr = c.req.query("cont");
  const cont = contStr == null || contStr.trim() === "" ? undefined : contStr;
  if (cont != null && !isUuid(cont)) return c.notFound();
  const pageStr = c.req.query("page");
  if (
    pageStr !== undefined &&
    (Number.isNaN(Number.parseInt(pageStr)) || Number.parseInt(pageStr) < 1)
  ) {
    return c.notFound();
  }
  const page =
    pageStr !== undefined && !Number.isNaN(Number.parseInt(pageStr))
      ? Number.parseInt(pageStr)
      : 1;
  const [{ totalPosts }] = await db
    .select({ totalPosts: count() })
    .from(posts)
    .where(
      and(
        eq(posts.accountId, owner.id),
        or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
        eq(posts.type, "Article")
      ),
    );
  const maxPage = Math.ceil(totalPosts / PAGE_SIZE);
  if (page > maxPage && !(page <= 1 && totalPosts < 1)) {
    return c.notFound();
  }
  const postList = await db.query.posts.findMany({
    where: and(
      eq(posts.accountId, owner.id),
      or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
      eq(posts.type, "Article")
    ),
    orderBy: desc(posts.id),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
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
  const atomUrl = new URL(c.req.url);
  atomUrl.pathname += "/atom.xml";
  atomUrl.search = "";
  const newerUrl = page > 1 ? `?page=${page - 1}` : undefined;
  const olderUrl =
    postList.length === PAGE_SIZE ? `?page=${page + 1}` : undefined;
  return c.html(
    <ProfilePage
      posts={postList.slice(0, PAGE_SIZE)}
      atomUrl={atomUrl.href}
      olderUrl={olderUrl}
      newerUrl={newerUrl}
    />,
  );
});

interface ProfilePageProps {
  readonly posts: (Post & {
    account: Account;
    media: Medium[];
    poll: (Poll & { options: PollOption[] }) | null;
    sharing:
    | (Post & {
      account: Account;
      media: Medium[];
      poll: (Poll & { options: PollOption[] }) | null;
      replyTarget: (Post & { account: Account }) | null;
      quoteTarget:
      | (Post & {
        account: Account;
        media: Medium[];
        poll: (Poll & { options: PollOption[] }) | null;
        replyTarget: (Post & { account: Account }) | null;
        reactions: Reaction[];
      })
      | null;
      reactions: Reaction[];
    })
    | null;
    replyTarget: (Post & { account: Account }) | null;
    quoteTarget:
    | (Post & {
      account: Account;
      media: Medium[];
      poll: (Poll & { options: PollOption[] }) | null;
      replyTarget: (Post & { account: Account }) | null;
      reactions: Reaction[];
    })
    | null;
    reactions: Reaction[];
  })[];
  readonly atomUrl: string;
  readonly olderUrl?: string;
  readonly newerUrl?: string;
}

function ProfilePage({
  posts,
  atomUrl,
  olderUrl,
  newerUrl,
}: ProfilePageProps) {
  return (
    <Layout
      title="Blog"
      links={[
        { rel: "alternate", type: "application/atom+xml", href: atomUrl },
      ]}
    >
      {posts.map((post) => (
        <PostView post={post} />
      ))}
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div>{newerUrl && <a href={newerUrl}>&larr; Newer</a>}</div>
        <div>{olderUrl && <a href={olderUrl}>Older &rarr;</a>}</div>
      </div>
    </Layout>
  );
}

blog.get("/atom.xml", async (c) => {
  const owner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.handle, "peter"),
    with: { account: true },
  });
  if (owner == null) return c.notFound();
  const postList = await db.query.posts.findMany({
    with: { account: true },
    where: and(
      eq(posts.accountId, owner.id),
      eq(posts.type, "Article")
    ),
    orderBy: desc(posts.published),
    limit: 100,
  });
  const canonicalUrl = new URL(c.req.url);
  canonicalUrl.search = "";
  const response = await c.html(
    <feed xmlns="http://www.w3.org/2005/Atom">
      <id>urn:uuid:{owner.id}</id>
      <title>{owner.account.name}</title>
      <link rel="self" type="application/atom+xml" href={canonicalUrl.href} />
      <link
        rel="alternate"
        type="text/html"
        href={owner.account.url ?? owner.account.iri}
      />
      <link
        rel="alternate"
        type="application/activity+json"
        href={owner.account.iri}
      />
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

export default blog;
