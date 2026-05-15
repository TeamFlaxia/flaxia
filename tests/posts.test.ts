import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert'
import { BASE_URL, resetDb, registerUser, loginUser, seedUserAndLogin } from './helpers/setup.ts'

describe('POST /api/posts', () => {
  beforeEach(resetDb)

  it('creates post successfully → 201', async () => {
    const { cookie } = await seedUserAndLogin('1')
    const res = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'Hello, this is a test post!' })
    })
    assert.equal(res.status, 201)
  })

  it('rejects text longer than 200 chars → 400', async () => {
    const { cookie } = await seedUserAndLogin('1')
    const longText = 'a'.repeat(201)
    const res = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: longText })
    })
    assert.equal(res.status, 400)
  })

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello' })
    })
    assert.equal(res.status, 401)
  })
})

describe('GET /api/posts', () => {
  beforeEach(resetDb)

  it('returns posts for guests → 200', async () => {
    const res = await fetch(`${BASE_URL}/api/posts`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(Array.isArray(data.posts))
  })

  it('cursor pagination works', async () => {
    const { cookie } = await seedUserAndLogin('1')
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'Post 1' })
    })
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'Post 2' })
    })

    const res = await fetch(`${BASE_URL}/api/posts?limit=1`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(data.posts.length <= 1)
  })

  it('username filter with cursor pagination works', async () => {
    const { username, cookie } = await seedUserAndLogin('user1')
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'Post 1' })
    })
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'Post 2' })
    })

    // Fetch first page
    const res1 = await fetch(`${BASE_URL}/api/posts?username=${username}&limit=1`)
    const data1 = await res1.json()
    assert.equal(data1.posts.length, 1)
    const cursor = data1.posts[0].created_at

    // Fetch second page
    const res2 = await fetch(`${BASE_URL}/api/posts?username=${username}&limit=1&cursor=${cursor}`)
    const data2 = await res2.json()
    assert.equal(data2.posts.length, 1)
    assert.notEqual(data2.posts[0].id, data1.posts[0].id)
  })
})

describe('POST /api/posts/:id/fresh', () => {
  beforeEach(resetDb)

  it('toggles fresh on own post', async () => {
    const { cookie } = await seedUserAndLogin('1')
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'My post' })
    })
    const createData = await createRes.json()
    const postId = createData.id

    const freshRes = await fetch(`${BASE_URL}/api/posts/${postId}/fresh`, {
      method: 'POST',
      headers: { Cookie: cookie }
    })
    assert.equal(freshRes.status, 200)

    const unfreshRes = await fetch(`${BASE_URL}/api/posts/${postId}/fresh`, {
      method: 'POST',
      headers: { Cookie: cookie }
    })
    assert.equal(unfreshRes.status, 200)
  })

  it('generates notification for other\'s post', async () => {
    await seedUserAndLogin('1')
    const { cookie: cookie2 } = await seedUserAndLogin('2')

    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2
      },
      body: JSON.stringify({ text: 'User 2 post' })
    })
    const createData = await createRes.json()
    const postId = createData.id

    const freshRes = await fetch(`${BASE_URL}/api/posts/${postId}/fresh`, {
      method: 'POST',
      headers: { Cookie: cookie2 }
    })
    assert.equal(freshRes.status, 200)
  })

  it('does not generate notification for own post', async () => {
    const { cookie } = await seedUserAndLogin('1')
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'My post' })
    })
    const createData = await createRes.json()
    const postId = createData.id

    const freshRes = await fetch(`${BASE_URL}/api/posts/${postId}/fresh`, {
      method: 'POST',
      headers: { Cookie: cookie }
    })
    assert.equal(freshRes.status, 200)
  })
})

describe('POST /api/posts/:id/report', () => {
  beforeEach(resetDb)

  it('reports post successfully → 201', async () => {
    const { cookie } = await seedUserAndLogin('1')
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'Reportable post' })
    })
    const createData = await createRes.json()
    const postId = createData.id

    const res = await fetch(`${BASE_URL}/api/posts/${postId}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ reason: 'spam' })
    })
    assert.equal(res.status, 201)
  })

  it('rejects duplicate report → 409', async () => {
    const { cookie } = await seedUserAndLogin('1')
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'Reportable post' })
    })
    const createData = await createRes.json()
    const postId = createData.id

    await fetch(`${BASE_URL}/api/posts/${postId}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ reason: 'spam' })
    })

    const res = await fetch(`${BASE_URL}/api/posts/${postId}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ reason: 'spam' })
    })
    assert.equal(res.status, 409)
  })

  it('rejects reporting own post → 403', async () => {
    const { cookie } = await seedUserAndLogin('1')
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'My post' })
    })
    const createData = await createRes.json()
    const postId = createData.id

    const res = await fetch(`${BASE_URL}/api/posts/${postId}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ reason: 'spam' })
    })
    assert.equal(res.status, 403)
  })

  it('3rd report triggers notification', async () => {
    const { cookie: cookie1 } = await seedUserAndLogin('1')
    const { cookie: cookie2 } = await seedUserAndLogin('2')
    const { cookie: cookie3 } = await seedUserAndLogin('3')

    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie1
      },
      body: JSON.stringify({ text: 'Reportable post' })
    })
    const createData = await createRes.json()
    const postId = createData.id

    await fetch(`${BASE_URL}/api/posts/${postId}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2
      },
      body: JSON.stringify({ reason: 'spam' })
    })

    await fetch(`${BASE_URL}/api/posts/${postId}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie3
      },
      body: JSON.stringify({ reason: 'spam' })
    })

    const res = await fetch(`${BASE_URL}/api/posts/${postId}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie1
      },
      body: JSON.stringify({ reason: 'spam' })
    })
    assert.equal(res.status, 201)
  })
})

describe('DELETE /api/posts/:id', () => {
  beforeEach(resetDb)

  it('deletes own post → 200', async () => {
    const { cookie } = await seedUserAndLogin('1')
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'My post' })
    })
    const createData = await createRes.json()
    const postId = createData.id

    const res = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie }
    })
    assert.equal(res.status, 200)
  })

  it('deletes own post with a reply → 200', async () => {
    const { cookie } = await seedUserAndLogin('1')
    
    // Create parent post
    const parentRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'Parent post' })
    })
    const parentData = await parentRes.json()
    const parentId = parentData.id

    // Create reply
    await fetch(`${BASE_URL}/api/posts/${parentId}/replies/prepare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'Reply' })
    })
    await fetch(`${BASE_URL}/api/posts/${parentId}/replies/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ text: 'Reply' })
    })

    // Try to delete parent post
    const res = await fetch(`${BASE_URL}/api/posts/${parentId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie }
    })
    assert.equal(res.status, 200)
  })

  it('rejects deleting other\'s post → 403', async () => {
    await seedUserAndLogin('1')
    const { cookie: cookie2 } = await seedUserAndLogin('2')

    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2
      },
      body: JSON.stringify({ text: 'User 2 post' })
    })
    const createData = await createRes.json()
    const postId = createData.id

    const res = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie2 }
    })
    assert.equal(res.status, 403)
  })

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/posts/some-id`, {
      method: 'DELETE'
    })
    assert.equal(res.status, 401)
  })
})
