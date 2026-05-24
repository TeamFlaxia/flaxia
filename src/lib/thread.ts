import { Post } from '../types/post'

export interface PostNode {
  post: Post
  children: PostNode[]
}

export function buildTree(posts: Post[]): PostNode[] {
  // Return all posts as flat root nodes (no nesting)
  return posts.map(post => ({ post, children: [] }))
}

export function findNode(tree: PostNode[], postId: string): PostNode | null {
  for (const node of tree) {
    if (node.post.id === postId) {
      return node
    }
    const found = findNode(node.children, postId)
    if (found) {
      return found
    }
  }
  return null
}

export function countReplies(tree: PostNode[]): number {
  let count = 0
  for (const node of tree) {
    count += 1 + countReplies(node.children)
  }
  return count
}
