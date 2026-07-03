import {
  BlogData as BlogDataSchema,
  Post as PostSchema,
  type BlogData,
  type Post,
} from '@foldkit/backend'
import { BackendClient } from '@foldkit/backend/Client'
import { Button, Input, Select, Textarea } from '@foldkit/ui'
import { Effect, Match as M, Schema as S } from 'effect'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import { Command, Runtime } from 'foldkit'
import { html, type Document, type Html } from 'foldkit/html'
import { m } from 'foldkit/message'
import { ts } from 'foldkit/schema'
import { evo } from 'foldkit/struct'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

// MODEL

export const BlogLoading = ts('BlogLoading')
export const BlogLoaded = ts('BlogLoaded', { data: BlogDataSchema })
export const BlogFailed = ts('BlogFailed', { error: S.String })

const BlogState = S.Union([BlogLoading, BlogLoaded, BlogFailed])

export const Model = S.Struct({
  blog: BlogState,
  selectedUserId: S.String,
  title: S.String,
  body: S.String,
  isSaving: S.Boolean,
  saveError: S.String,
})
export type Model = typeof Model.Type

// MESSAGE

export const ClickedRefresh = m('ClickedRefresh')
export const UpdatedSelectedUser = m('UpdatedSelectedUser', {
  userId: S.String,
})
export const UpdatedTitle = m('UpdatedTitle', { value: S.String })
export const UpdatedBody = m('UpdatedBody', { value: S.String })
export const SubmittedPostForm = m('SubmittedPostForm')
export const SucceededLoadBlogData = m('SucceededLoadBlogData', {
  data: BlogDataSchema,
})
export const FailedLoadBlogData = m('FailedLoadBlogData', {
  error: S.String,
})
export const SucceededCreatePost = m('SucceededCreatePost', {
  post: PostSchema,
})
export const FailedCreatePost = m('FailedCreatePost', { error: S.String })

export const Message = S.Union([
  ClickedRefresh,
  UpdatedSelectedUser,
  UpdatedTitle,
  UpdatedBody,
  SubmittedPostForm,
  SucceededLoadBlogData,
  FailedLoadBlogData,
  SucceededCreatePost,
  FailedCreatePost,
])
export type Message = typeof Message.Type

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => [
  {
    blog: BlogLoading(),
    selectedUserId: '',
    title: '',
    body: '',
    isSaving: false,
    saveError: '',
  },
  [FetchBlogData()],
]

// COMMAND

const backend = BackendClient(API_URL)

export const FetchBlogData = Command.define(
  'FetchBlogData',
  SucceededLoadBlogData,
  FailedLoadBlogData,
)(
  backend.pipe(
    Effect.flatMap(api => api.Blog.listBlogData()),
    Effect.map(data => SucceededLoadBlogData({ data })),
    Effect.catch(error =>
      Effect.succeed(FailedLoadBlogData({ error: String(error) })),
    ),
    Effect.provide(FetchHttpClient.layer),
  ),
)

export const CreatePost = Command.define(
  'CreatePost',
  {
    userId: S.Number,
    title: S.String,
    body: S.String,
  },
  SucceededCreatePost,
  FailedCreatePost,
)((payload) =>
  backend.pipe(
    Effect.flatMap(api => api.Blog.createPost({ payload })),
    Effect.map(post => SucceededCreatePost({ post })),
    Effect.catch(error =>
      Effect.succeed(FailedCreatePost({ error: String(error) })),
    ),
    Effect.provide(FetchHttpClient.layer),
  ),
)

// UPDATE

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>]
const withUpdateReturn = M.withReturnType<UpdateReturn>()
const noCommands = (model: Model): UpdateReturn => [model, []]
const withCommand = (
  model: Model,
  command: Command.Command<Message>,
): UpdateReturn => [model, [command]]
const fetchBlogData = (): Command.Command<Message> => FetchBlogData()
const createPost = (payload: {
  userId: number
  title: string
  body: string
}): Command.Command<Message> => CreatePost(payload)

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      ClickedRefresh: () =>
        withCommand(
          evo(model, {
            blog: () => BlogLoading(),
            saveError: () => '',
          }),
          fetchBlogData(),
        ),

      UpdatedSelectedUser: ({ userId }) =>
        noCommands(evo(model, { selectedUserId: () => userId })),

      UpdatedTitle: ({ value }) =>
        noCommands(
          evo(model, {
            title: () => value,
            saveError: () => '',
          }),
        ),

      UpdatedBody: ({ value }) =>
        noCommands(
          evo(model, {
            body: () => value,
            saveError: () => '',
          }),
        ),

      SubmittedPostForm: () => {
        if (model.blog._tag !== 'BlogLoaded' || model.isSaving) {
          return noCommands(model)
        }

        const title = model.title.trim()
        const body = model.body.trim()

        if (title === '' || body === '') {
          return noCommands(
            evo(model, {
              saveError: () => 'Title and body are required.',
            }),
          )
        }

        const userId = Number(model.selectedUserId)
        const author = model.blog.data.users.find(user => user.id === userId)

        if (author === undefined) {
          return noCommands(
            evo(model, {
              saveError: () => 'Select an author.',
            }),
          )
        }

        return withCommand(
          evo(model, {
            isSaving: () => true,
            saveError: () => '',
          }),
          createPost({ userId: author.id, title, body }),
        )
      },

      SucceededLoadBlogData: ({ data }) =>
        noCommands(
          evo(model, {
            blog: () => BlogLoaded({ data }),
            selectedUserId: current =>
              data.users.some(user => user.id.toString() === current)
                ? current
                : (data.users[0]?.id.toString() ?? ''),
          }),
        ),

      FailedLoadBlogData: ({ error }) =>
        noCommands(
          evo(model, {
            blog: () => BlogFailed({ error }),
          }),
        ),

      SucceededCreatePost: ({ post }) =>
        noCommands(
          evo(model, {
            blog: blog =>
              blog._tag === 'BlogLoaded'
                ? BlogLoaded({
                    data: {
                      users: blog.data.users,
                      posts: [post, ...blog.data.posts],
                    },
                  })
                : blog,
            title: () => '',
            body: () => '',
            isSaving: () => false,
            saveError: () => '',
          }),
        ),

      FailedCreatePost: ({ error }) =>
        noCommands(
          evo(model, {
            isSaving: () => false,
            saveError: () => error,
          }),
        ),
    }),
  )

// VIEW

export const view = (model: Model): Document => {
  const h = html<Message>()

  return {
    title: 'Posts',
    body: h.main(
      [h.Class('min-h-screen bg-white text-gray-900')],
      [
        h.section(
          [h.Class('max-w-4xl mx-auto px-4 py-8')],
          [
            h.header(
              [h.Class('flex items-end justify-between gap-4 mb-6')],
              [
                h.div([], [
                  h.p(
                    [h.Class('text-sm font-bold uppercase text-blue-700 mb-1')],
                    ['Alchemy + Foldkit + Neon'],
                  ),
                  h.h1([h.Class('text-4xl font-bold leading-tight')], [
                    'Posts',
                  ]),
                ]),
                Button.view<Message>({
                  onClick: ClickedRefresh(),
                  toView: attributes =>
                    h.button(
                      [
                        ...attributes.button,
                        h.Class('border border-blue-600 bg-blue-600 text-white px-4 py-2'),
                      ],
                      ['Refresh'],
                    ),
                }),
              ],
            ),

            M.value(model.blog).pipe(
              M.tagsExhaustive({
                BlogLoading: () =>
                  h.div([h.Class('border p-4 text-gray-600')], [
                    'Loading posts...',
                  ]),
                BlogFailed: ({ error }) =>
                  h.div([h.Class('border p-4 text-red-700')], [error]),
                BlogLoaded: ({ data }) => blogView(model, data),
              }),
            ),
          ],
        ),
      ],
    ),
  }
}

const blogView = (model: Model, data: BlogData): Html => {
  const h = html<Message>()

  return h.section(
    [h.Class('grid gap-6 md:grid-cols-[320px_1fr] items-start')],
    [
      composerView(model, data),
      h.div(
        [h.Class('grid gap-4')],
        data.posts.length === 0
          ? [h.div([h.Class('border p-4 text-gray-600')], ['No posts yet.'])]
          : data.posts.map(postView),
      ),
    ],
  )
}

const composerView = (model: Model, data: BlogData): Html => {
  const h = html<Message>()
  const canSubmit =
    !model.isSaving &&
    data.users.length > 0 &&
    model.title.trim() !== '' &&
    model.body.trim() !== ''

  return h.form(
    [
      h.Class('grid gap-4 border p-4 md:sticky md:top-6'),
      h.OnSubmit(SubmittedPostForm()),
    ],
    [
      h.h2([h.Class('text-lg font-bold text-blue-700')], ['Create post']),
      Select.view<Message>({
        id: 'author',
        value: model.selectedUserId,
        onChange: userId => UpdatedSelectedUser({ userId }),
        isDisabled: model.isSaving || data.users.length === 0,
        toView: attributes =>
          h.label(
            [h.Class('grid gap-1')],
            [
              h.span([...attributes.label, h.Class('text-sm font-bold')], [
                'Author',
              ]),
              h.select(
                [...attributes.select, h.Class('border px-3 py-2 w-full')],
                data.users.length === 0
                  ? [h.option([h.Value('')], ['No users'])]
                  : data.users.map(user =>
                      h.option([h.Value(user.id.toString())], [user.name]),
                    ),
              ),
            ],
          ),
      }),
      Input.view<Message>({
        id: 'title',
        value: model.title,
        placeholder: 'A short title',
        onInput: value => UpdatedTitle({ value }),
        isDisabled: model.isSaving,
        toView: attributes =>
          h.label(
            [h.Class('grid gap-1')],
            [
              h.span([...attributes.label, h.Class('text-sm font-bold')], [
                'Title',
              ]),
              h.input([...attributes.input, h.Class('border px-3 py-2 w-full')]),
            ],
          ),
      }),
      Textarea.view<Message>({
        id: 'body',
        value: model.body,
        placeholder: 'Write the post body',
        rows: 6,
        onInput: value => UpdatedBody({ value }),
        isDisabled: model.isSaving,
        toView: attributes =>
          h.label(
            [h.Class('grid gap-1')],
            [
              h.span([...attributes.label, h.Class('text-sm font-bold')], [
                'Body',
              ]),
              h.textarea(
                [...attributes.textarea, h.Class('border px-3 py-2 w-full')],
                [],
              ),
            ],
          ),
      }),
      Button.view<Message>({
        type: 'submit',
        isDisabled: !canSubmit,
        toView: attributes =>
          h.button(
            [
              ...attributes.button,
              h.Class('border border-blue-600 bg-blue-600 text-white px-4 py-2 disabled:opacity-50'),
            ],
            [model.isSaving ? 'Creating...' : 'Create post'],
          ),
      }),
      model.saveError === ''
        ? h.empty
        : h.div([h.Class('border p-4 text-red-700')], [model.saveError]),
    ],
  )
}

const postView = (post: Post): Html => {
  const h = html<Message>()

  return h.article(
    [h.Class('border p-4'), h.Key(post.id.toString())],
    [
      h.div(
        [h.Class('flex items-start justify-between gap-4')],
        [
          h.h2([h.Class('text-xl font-bold leading-snug')], [post.title]),
          h.span([h.Class('text-sm font-bold text-blue-700')], [
            post.user.name,
          ]),
        ],
      ),
      h.p([h.Class('mt-3 leading-relaxed text-gray-700')], [post.body]),
    ],
  )
}
