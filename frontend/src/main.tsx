import { BackendClient } from "@foldkit/backend/Client";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import React from "react";
import { createRoot } from "react-dom/client";
import type { BlogData, Post } from "@foldkit/backend";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

const client = BackendClient(API_URL).pipe(Effect.provide(FetchHttpClient.layer));

function runClient<A>(effect: Effect.Effect<A, unknown, never>) {
  return Effect.runPromise(effect);
}

function App() {
  const [data, setData] = React.useState<BlogData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [userId, setUserId] = React.useState<number | null>(null);

  const load = React.useCallback(() => {
    runClient(client.pipe(Effect.flatMap((api) => api.Blog.listBlogData())))
      .then((next) => {
        setData(next);
        setUserId((current) => current ?? next.users[0]?.id ?? null);
        setError(null);
      })
      .catch((cause) => setError(String(cause)));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!userId || !title.trim() || !body.trim()) return;

    setIsSaving(true);
    runClient(
      client.pipe(
        Effect.flatMap((api) =>
          api.Blog.createPost({
            payload: {
              userId,
              title,
              body,
            },
          }),
        ),
      ),
    )
      .then((post) => {
        setData((current) =>
          current
            ? {
                users: current.users,
                posts: [post as Post, ...current.posts],
              }
            : current,
        );
        setTitle("");
        setBody("");
        setError(null);
      })
      .catch((cause) => setError(String(cause)))
      .finally(() => setIsSaving(false));
  };

  return (
    <main className="shell">
      <section className="toolbar">
        <div>
          <p className="eyebrow">Neon + Hyperdrive</p>
          <h1>Posts</h1>
        </div>
        <button type="button" onClick={load}>
          Refresh
        </button>
      </section>

      {error ? <div className="error">{error}</div> : null}

      <section className="layout">
        <form className="composer" onSubmit={submit}>
          <h2>Create post</h2>
          <label>
            <span>Author</span>
            <select
              value={userId ?? ""}
              onChange={(event) => setUserId(Number(event.target.value))}
            >
              {data?.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="A short title"
            />
          </label>
          <label>
            <span>Body</span>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Write the post body"
              rows={6}
            />
          </label>
          <button disabled={isSaving || !userId || !title.trim() || !body.trim()}>
            {isSaving ? "Creating..." : "Create post"}
          </button>
        </form>

        <div className="feed">
          {!data ? (
            <div className="empty">Loading posts...</div>
          ) : (
            data.posts.map((post) => (
              <article className="post" key={post.id}>
                <div className="postHeader">
                  <h2>{post.title}</h2>
                  <span>{post.user.name}</span>
                </div>
                <p>{post.body}</p>
              </article>
            ))
          )}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
