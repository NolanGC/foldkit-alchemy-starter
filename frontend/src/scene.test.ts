import { Scene } from 'foldkit'
import { describe, test } from 'vitest'

import {
  BlogLoaded,
  CreatePost,
  SucceededCreatePost,
  update,
  view,
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

const loadedModel: Model = {
  blog: BlogLoaded({
    data: {
      users: [ada, grace],
      posts: [firstPost],
    },
  }),
  selectedUserId: ada.id.toString(),
  title: '',
  body: '',
  isSaving: false,
  saveError: '',
}

describe('view', () => {
  test('loaded posts render with the composer', () => {
    Scene.scene(
      { update, view },
      Scene.with(loadedModel),
      Scene.expect(Scene.role('heading', { name: 'Posts' })).toExist(),
      Scene.expect(Scene.text('Seed post')).toExist(),
      Scene.expect(Scene.text('Ada Lovelace')).toExist(),
      Scene.expect(Scene.role('button', { name: 'Create post' })).toBeDisabled(),
    )
  })

  test('creating a post dispatches the backend command and renders the result', () => {
    const createPostCommand = CreatePost({
      userId: grace.id,
      title: 'New post',
      body: 'Created from the Foldkit form.',
    })

    Scene.scene(
      { update, view },
      Scene.with(loadedModel),
      Scene.change(Scene.selector('#author'), grace.id.toString()),
      Scene.type(Scene.placeholder('A short title'), 'New post'),
      Scene.type(
        Scene.placeholder('Write the post body'),
        'Created from the Foldkit form.',
      ),
      Scene.click(Scene.role('button', { name: 'Create post' })),
      Scene.Command.expectExact(createPostCommand),
      Scene.Command.resolve(
        createPostCommand,
        SucceededCreatePost({ post: createdPost }),
      ),
      Scene.expect(Scene.text('New post')).toExist(),
      Scene.expect(Scene.text('Grace Hopper')).toExist(),
    )
  })
})
