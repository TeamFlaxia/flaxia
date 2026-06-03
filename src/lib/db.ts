export interface Post {
  id: string;
  user_id: string;
  username: string;
  text: string;
  hashtags: string;
  gif_key?: string;
  payload_key?: string;
  fresh_count: number;
  created_at: string;
}

export interface Follow {
  follower_id: string;
  followee_id: string;
}

export interface Fresh {
  post_id: string;
  user_id: string;
}

export class Database {
  constructor(private db: D1Database) {}

  async getPosts(cursor?: string, limit = 10): Promise<Post[]> {
    let query = 'SELECT * FROM posts ORDER BY created_at DESC LIMIT ?';
    const params: unknown[] = [limit];

    if (cursor) {
      query = 'SELECT * FROM posts WHERE created_at < ? ORDER BY created_at DESC LIMIT ?';
      params.unshift(cursor);
    }

    const result = await this.db
      .prepare(query)
      .bind(...params)
      .all<Post>();
    return result.results;
  }

  async createPost(post: Omit<Post, 'created_at' | 'fresh_count' | 'favorite_count'>): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, gif_key, payload_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(id, post.user_id, post.username, post.text, post.hashtags, post.gif_key || null, post.payload_key || null)
      .run();

    return id;
  }

  async follow(followerId: string, followeeId: string): Promise<boolean> {
    const result = await this.db
      .prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)')
      .bind(followerId, followeeId)
      .run();
    return result.meta.changes > 0;
  }

  async unfollow(followerId: string, followeeId: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?')
      .bind(followerId, followeeId)
      .run();
    return result.meta.changes > 0;
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    const result = await this.db
      .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?')
      .bind(followerId, followeeId)
      .first();
    return result !== null;
  }

  async getFollowCounts(userId: string): Promise<{ followers: number; following: number }> {
    const [followersResult, followingResult] = await Promise.all([
      this.db.prepare('SELECT COUNT(*) as count FROM follows WHERE followee_id = ?').bind(userId).first(),
      this.db.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').bind(userId).first(),
    ]);
    return {
      followers: (followersResult?.count as number) || 0,
      following: (followingResult?.count as number) || 0,
    };
  }

  async getFollowers(userId: string): Promise<string[]> {
    const result = await this.db
      .prepare('SELECT follower_id FROM follows WHERE followee_id = ?')
      .bind(userId)
      .all<{ follower_id: string }>();
    return result.results.map((r) => r.follower_id);
  }

  async getFollowing(userId: string): Promise<string[]> {
    const result = await this.db
      .prepare('SELECT followee_id FROM follows WHERE follower_id = ?')
      .bind(userId)
      .all<{ followee_id: string }>();
    return result.results.map((r) => r.followee_id);
  }
}
