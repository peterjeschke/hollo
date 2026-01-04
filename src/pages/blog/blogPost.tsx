import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { Layout } from "../../components/Layout.tsx";
import { SiteHeader } from "../../components/SiteHeader.tsx";
import { renderCustomEmojis } from "../../custom-emoji";
import db from "../../db.ts";
import {
  type Account,
  type AccountOwner,
  type Post,
  accountOwners,
  posts,
} from "../../schema.ts";
import { isUuid } from "../../uuid.ts";

const blogPost = new Hono();

blogPost.get<"/blog/:id{[-a-f0-9]+}">(async (c) => {
  const postId = c.req.param("id");
  if (!isUuid(postId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.handle, "peter"),
  });
  if (accountOwner == null) return c.notFound();
  const post = await db.query.posts.findFirst({
    where: and(
      eq(posts.accountId, accountOwner.id),
      eq(posts.id, postId),
      or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
      eq(posts.type, "Article"),
    ),
    with: {
      account: true,
    },
  });
  if (post == null) return c.notFound();
  return c.html(<PostPage post={post} accountOwner={accountOwner} />);
});

interface PostPageProps {
  readonly accountOwner: AccountOwner;
  readonly post: Post & { account: Account };
}

function PostPage({ post, accountOwner }: PostPageProps) {
  const contentHtml = renderCustomEmojis(post.contentHtml, post.emojis);
  const title = post.summary ?? "Blog post";
  return (
    <Layout
      title={title}
      description={post.summary ?? post.content}
      imageUrl={post.account.avatarUrl}
      url={post.url ?? post.iri}
      links={[
        { rel: "alternate", type: "application/activity+json", href: post.iri },
      ]}
      themeColor={accountOwner.themeColor}
    >
      <SiteHeader />
      <article>
        <header>
          <h2>{title}</h2>
          <p>
            <small>
              Published{" "}
              <time dateTime={(post.published ?? post.updated).toISOString()}>
                {(post.published ?? post.updated).toLocaleString("en", {
                  dateStyle: "long",
                })}
              </time>
            </small>
          </p>
        </header>
        {contentHtml && (
          <div
            dangerouslySetInnerHTML={{ __html: contentHtml }}
            lang={post.language ?? undefined}
          />
        )}
      </article>
    </Layout>
  );
}

export default blogPost;
