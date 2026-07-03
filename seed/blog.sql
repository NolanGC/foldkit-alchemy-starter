WITH seed_users(email, name) AS (
  VALUES
    ('ada@example.com', 'Ada Lovelace'),
    ('grace@example.com', 'Grace Hopper'),
    ('katherine@example.com', 'Katherine Johnson')
)
INSERT INTO users (email, name)
SELECT email, name
FROM seed_users
ON CONFLICT (email) DO NOTHING;

WITH seed_posts(email, title, body) AS (
  VALUES
    (
      'ada@example.com',
      'A small note on clean systems',
      'Simple data models make the interface easier to reason about.'
    ),
    (
      'grace@example.com',
      'Shipping useful software',
      'Keep the loop tight: deploy, observe, adjust, and remove what does not earn its keep.'
    ),
    (
      'katherine@example.com',
      'Typed APIs at the edge',
      'A shared contract keeps the Worker and frontend honest without a separate code generator.'
    )
)
INSERT INTO posts (user_id, title, body)
SELECT users.id, seed_posts.title, seed_posts.body
FROM seed_posts
JOIN users ON users.email = seed_posts.email
WHERE NOT EXISTS (
  SELECT 1
  FROM posts
  WHERE posts.user_id = users.id
    AND posts.title = seed_posts.title
    AND posts.body = seed_posts.body
);
