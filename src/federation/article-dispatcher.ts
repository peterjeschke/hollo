import { Article } from "@fedify/vocab";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { accounts } from "../schema";
import { isUuid } from "../uuid";
import { federation } from "./federation";
import { toObject } from "./post";

federation.setObjectDispatcher(
  Article,
  "/articles/@{username}/{id}",
  async (ctx, values) => {
    if (!isUuid(values.id)) return null;
    const owner = await db.query.accountOwners.findFirst({
      where: { handle: { eq: values.username } },
      with: { account: true },
    });
    if (owner == null) return null;
    const post = await db.query.posts.findFirst({
      where: {
        id: { eq: values.id },
        accountId: { eq: owner.account.id },
        type: { eq: "Article" },
      },
      with: {
        account: { with: { owner: true } },
        replyTarget: true,
        quoteTarget: true,
        media: true,
        poll: { with: { options: { orderBy: { index: "asc" } } } },
        mentions: { with: { account: true } },
        replies: true,
      },
    });
    if (post == null) return null;
    if (post.visibility === "private") {
      const keyOwner = await ctx.getSignedKeyOwner();
      const keyOwnerId = keyOwner?.id;
      if (keyOwnerId == null) return null;
      const found = await db.query.follows.findFirst({
        where: {
          followingId: owner.id,
          followerId: {
            inArray: db
              .select({ id: accounts.id })
              .from(accounts)
              .where(eq(accounts.iri, keyOwnerId.href)),
          },
        },
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
