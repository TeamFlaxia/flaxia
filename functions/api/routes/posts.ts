import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { composer } from './posts/composer.ts';
import { counter } from './posts/counter.ts';
import { discovery } from './posts/discovery.ts';
import { engagement } from './posts/engagement.ts';
import { feed } from './posts/feed.ts';
import { manage } from './posts/manage.ts';
import { recommendations } from './posts/recommendations.ts';
import { replies } from './posts/replies.ts';
import { search } from './posts/search.ts';

const posts = new Hono<{ Bindings: Bindings; Variables: Variables }>();

posts.route('/', feed);
posts.route('/', recommendations);
posts.route('/', discovery);
posts.route('/', composer);
posts.route('/', engagement);
posts.route('/', replies);
posts.route('/', search);
posts.route('/', manage);
posts.route('/', counter);

export default posts;
