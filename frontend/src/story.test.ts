import { Story } from 'foldkit'
import { describe, expect, test } from 'vitest'

import {
  BlogLoaded,
  ClickedRefresh,
  CreatePost,
  FailedCreatePost,
  FetchBlogData,
  SubmittedPostForm,
  SucceededCreatePost,
  SucceededLoadBlogData,
  UpdatedBody,
  UpdatedSelectedUser,
  UpdatedTitle,
  init,
  update,
  type Model,
} from './main'

const ada = {
  id: 1,
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  createdAt: '2026-07-03T00:00:00.000Z',
}

const grace = {
  id: 2,
  email: 'grace@example.com',
  name: 'Grace Hopper',
  createdAt: '2026-07-03T00:00:00.000Z',
}

const firstPost = {
  id: 10,
  userId: ada.id,
  title: 'Seed post',
  body: 'This came from seed data.',
  createdAt: '2026-07-03T00:00:00.000Z',
  user: ada,
}

const createdPost = {
  id: 11,
  userId: grace.id,
  title: 'New post',
  body: 'Created from the Foldkit form.',
  createdAt: '2026-07-03T00:01:00.000Z',
  user: grace,
}

const blogData = {
  users: [ada, grace],
  posts: [firstPost],
}

const loadingModel: Model = {
  blog: { _tag: 'BlogLoading' },
  selectedUserId: '',
  title: '',
  body: '',
  isSaving: false,
  saveError: '',
}

const loadedModel: Model = {
  ...loadingModel,
  blog: BlogLoaded({ data: blogData }),
  selectedUserId: ada.id.toString(),
}

describe('update', () => {
  test('init starts loading blog data', () => {
    const [model, commands] = init()

    expect(model.blog._tag).toBe('BlogLoading')
    expect(commands).toHaveLength(1)
    expect(commands[0]!.name).toBe(FetchBlogData.name)
  })

  test('refresh loads data and selects the first user', () => {
    Story.story(
      update,
      Story.with(loadingModel),
      Story.message(ClickedRefresh()),
      Story.Command.expectExact(FetchBlogData),
      Story.Command.resolve(
        FetchBlogData,
        SucceededLoadBlogData({ data: blogData }),
      ),
      Story.model(model => {
        expect(model.blog._tag).toBe('BlogLoaded')
        expect(model.selectedUserId).toBe(ada.id.toString())
      }),
    )
  })

  test('submitting a valid post dispatches CreatePost and prepends the result', () => {
    const createPostCommand = CreatePost({
      userId: grace.id,
      title: 'New post',
      body: 'Created from the Foldkit form.',
    })

    Story.story(
      update,
      Story.with(loadedModel),
      Story.message(UpdatedSelectedUser({ userId: grace.id.toString() })),
      Story.Command.expectNone(),
      Story.message(UpdatedTitle({ value: '  New post  ' })),
      Story.Command.expectNone(),
      Story.message(UpdatedBody({ value: '  Created from the Foldkit form.  ' })),
      Story.Command.expectNone(),
      Story.message(SubmittedPostForm()),
      Story.Command.expectExact(createPostCommand),
      Story.Command.resolve(
        createPostCommand,
        SucceededCreatePost({ post: createdPost }),
      ),
      Story.model(model => {
        expect(model.blog._tag).toBe('BlogLoaded')
        if (model.blog._tag === 'BlogLoaded') {
          expect(model.blog.data.posts[0]).toEqual(createdPost)
        }
        expect(model.title).toBe('')
        expect(model.body).toBe('')
        expect(model.isSaving).toBe(false)
        expect(model.saveError).toBe('')
      }),
    )
  })

  test('empty form submission stays pure and records validation error', () => {
    Story.story(
      update,
      Story.with(loadedModel),
      Story.message(SubmittedPostForm()),
      Story.Command.expectNone(),
      Story.model(model => {
        expect(model.saveError).toBe('Title and body are required.')
      }),
    )
  })

  test('failed create keeps draft and stores error', () => {
    const createPostCommand = CreatePost({
      userId: grace.id,
      title: 'New post',
      body: 'Created from the Foldkit form.',
    })

    Story.story(
      update,
      Story.with({
        ...loadedModel,
        selectedUserId: grace.id.toString(),
        title: 'New post',
        body: 'Created from the Foldkit form.',
      }),
      Story.message(SubmittedPostForm()),
      Story.Command.expectHas(createPostCommand),
      Story.Command.resolve(
        createPostCommand,
        FailedCreatePost({ error: 'Backend rejected the post.' }),
      ),
      Story.model(model => {
        expect(model.title).toBe('New post')
        expect(model.body).toBe('Created from the Foldkit form.')
        expect(model.isSaving).toBe(false)
        expect(model.saveError).toBe('Backend rejected the post.')
      }),
    )
  })
})
