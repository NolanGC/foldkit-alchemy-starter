import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

export const User = Schema.Struct({
  id: Schema.Number,
  email: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
});
export type User = typeof User.Type;

export const Post = Schema.Struct({
  id: Schema.Number,
  userId: Schema.Number,
  title: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  user: User,
});
export type Post = typeof Post.Type;

export const BlogData = Schema.Struct({
  users: Schema.Array(User),
  posts: Schema.Array(Post),
});
export type BlogData = typeof BlogData.Type;

export const CreatePostInput = Schema.Struct({
  userId: Schema.Number,
  title: Schema.String,
  body: Schema.String,
});

export const DeletePostOutput = Schema.Struct({
  id: Schema.Number,
});

export const listBlogData = HttpApiEndpoint.get("listBlogData", "/api/posts", {
  success: BlogData,
});

export const createPost = HttpApiEndpoint.post("createPost", "/api/posts", {
  payload: CreatePostInput,
  success: Post,
});

export const deletePost = HttpApiEndpoint.delete(
  "deletePost",
  "/api/posts/:id",
  {
    params: Schema.Struct({
      id: Schema.NumberFromString,
    }),
    success: DeletePostOutput,
  },
);

export class BlogGroup extends HttpApiGroup.make("Blog")
  .add(listBlogData)
  .add(createPost)
  .add(deletePost) {}

export class BackendApi extends HttpApi.make("BackendApi").add(BlogGroup) {}
