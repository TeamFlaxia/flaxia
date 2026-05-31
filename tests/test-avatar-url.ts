// Test to verify avatar URL generation in RightPanel
interface UserSuggestion {
  id: string
  username: string
  display_name: string
  avatar_key?: string
}

// Simulate the avatar URL generation logic from RightPanel
function generateAvatarUrl(user: UserSuggestion): string {
  return user.avatar_key ? `/api/images/${user.avatar_key}` : 'none'
}

// Test cases
const testUsers: UserSuggestion[] = [
  {
    id: '1',
    username: 'user1',
    display_name: 'Test User 1',
    avatar_key: 'avatar/abc123'
  },
  {
    id: '2', 
    username: 'user2',
    display_name: 'Test User 2',
    avatar_key: undefined
  }
]

testUsers.forEach(user => {
  const avatarUrl = generateAvatarUrl(user)
  console.log(`User: ${user.display_name}, Avatar URL: ${avatarUrl}`)
})

// Expected output:
// User: Test User 1, Avatar URL: /api/images/avatar/abc123
// User: Test User 2, Avatar URL: none
