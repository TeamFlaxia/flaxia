#!/usr/bin/env node

// Simple test script for ActivityPub inbox endpoint
const testInbox = async () => {
  const baseUrl = process.env.BASE_URL || 'http://localhost:8787'
  const username = process.env.TEST_USERNAME || 'remydrescarlet'
  const inboxUrl = `${baseUrl}/users/${username}/inbox`

  // Sample Follow activity
  const followActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: 'https://mastodon.example.com/activities/follow-test-123',
    type: 'Follow',
    actor: 'https://mastodon.example.com/users/testuser',
    object: `${baseUrl}/users/${username}`
  }

  // Sample Create activity (note)
  const createActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: 'https://mastodon.example.com/activities/create-test-456',
    type: 'Create',
    actor: 'https://mastodon.example.com/users/testuser',
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    object: {
      id: 'https://mastodon.example.com/objects/note-test-789',
      type: 'Note',
      content: 'Hello from Mastodon!',
      attributedTo: 'https://mastodon.example.com/users/testuser',
      to: ['https://www.w3.org/ns/activitystreams#Public']
    }
  }

  console.log('Testing ActivityPub inbox endpoint...')
  console.log(`Target URL: ${inboxUrl}`)
  console.log('')

  // Test Follow activity
  console.log('🎯 Testing Follow activity...')
  try {
    const response = await fetch(inboxUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/activity+json',
        'Host': new URL(baseUrl).host,
        'Date': new Date().toUTCString(),
        'User-Agent': 'ActivityPub-Test-Script/1.0'
      },
      body: JSON.stringify(followActivity)
    })
    
    console.log(`Status: ${response.status} ${response.statusText}`)
    if (response.status === 202) {
      console.log('✅ Follow activity accepted!')
    } else {
      console.log('❌ Unexpected response')
    }
  } catch (error) {
    console.error('❌ Error sending Follow activity:', error)
  }

  console.log('')

  // Test Create activity
  console.log('📝 Testing Create activity...')
  try {
    const response = await fetch(inboxUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/activity+json',
        'Host': new URL(baseUrl).host,
        'Date': new Date().toUTCString(),
        'User-Agent': 'ActivityPub-Test-Script/1.0'
      },
      body: JSON.stringify(createActivity)
    })
    
    console.log(`Status: ${response.status} ${response.statusText}`)
    if (response.status === 202) {
      console.log('✅ Create activity accepted!')
    } else {
      console.log('❌ Unexpected response')
    }
  } catch (error) {
    console.error('❌ Error sending Create activity:', error)
  }

  console.log('')
  console.log('Test completed! Check the server logs to see the detailed output.')
}

// Run the test
testInbox().catch(console.error)
