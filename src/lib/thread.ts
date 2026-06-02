import { Post } from '../types/post';

export interface PostNode {
  post: Post;
  children: PostNode[];
}

export function buildTree(posts: Post[]): PostNode[] {
  const nodeMap = new Map<string, PostNode>();
  const roots: PostNode[] = [];

  for (const post of posts) {
    nodeMap.set(post.id, { post, children: [] });
  }

  for (const post of posts) {
    const node = nodeMap.get(post.id)!;
    if (post.parent_id) {
      const parentNode = nodeMap.get(post.parent_id);
      if (parentNode) {
        parentNode.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  const sortByDate = (a: PostNode, b: PostNode) =>
    new Date(a.post.created_at).getTime() - new Date(b.post.created_at).getTime();

  for (const node of nodeMap.values()) {
    node.children.sort(sortByDate);
  }
  roots.sort(sortByDate);

  return roots;
}

export function findNode(tree: PostNode[], postId: string): PostNode | null {
  for (const node of tree) {
    if (node.post.id === postId) {
      return node;
    }
    const found = findNode(node.children, postId);
    if (found) {
      return found;
    }
  }
  return null;
}

export function countReplies(tree: PostNode[]): number {
  let count = 0;
  for (const node of tree) {
    count += 1 + countReplies(node.children);
  }
  return count;
}
