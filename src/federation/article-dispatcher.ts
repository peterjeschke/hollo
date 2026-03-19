import { Article } from "@fedify/vocab";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { accountOwners, accounts, follows, pollOptions, posts } from "../schema";
import { isUuid } from "../uuid";
import { federation } from "./federation";
import { toObject } from "./post";

federation.setObjectDispatcher(
  Article,
  "/articles/@{username}/{id}",
  async (ctx, values) => {
    if (!isUuid(values.id)) return null;
    const owner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.handle, values.username),
      with: { account: true },
    });
    if (owner == null) return null;
    const post = await db.query.posts.findFirst({
      where: and(
        eq(posts.id, values.id),
        eq(posts.accountId, owner.account.id),
        eq(posts.type, "Article"),
      ),
      with: {
        account: { with: { owner: true } },
        replyTarget: true,
        quoteTarget: true,
        media: true,
        poll: { with: { options: { orderBy: pollOptions.index } } },
        mentions: { with: { account: true } },
        replies: true,
      },
    });
    if (post == null) return null;
    if (post.visibility === "private") {
      const keyOwner = await ctx.getSignedKeyOwner();
      if (keyOwner?.id == null) return null;
      const found = await db.query.follows.findFirst({
        where: and(
          inArray(
            follows.followerId,
            db
              .select({ id: accounts.id })
              .from(accounts)
              .where(eq(accounts.iri, keyOwner.id.href)),
          ),
          eq(follows.followingId, owner.id),
        ),
      });
      if (found == null) return null;
    } else if (post.visibility === "direct") {
      const keyOwner = await ctx.getSignedKeyOwner();
      const keyOwnerId = keyOwner?.id;
      if (keyOwnerId == null) return null;
      const found = post.mentions.some(
        (m) => m.account.iri === keyOwnerId.href,
      );
      if (!found) return null;
    }
    return toObject(post, ctx);
  },
);
