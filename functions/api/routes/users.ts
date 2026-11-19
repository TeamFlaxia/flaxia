import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { accountProfile } from './users/account-profile.ts';
import { avatar } from './users/avatar.ts';
import { deletion } from './users/deletion.ts';
import { profiles } from './users/profiles.ts';
import { relationships } from './users/relationships.ts';
import { security } from './users/security.ts';
import { social } from './users/social.ts';

const users = new Hono<{ Bindings: Bindings; Variables: Variables }>();

users.route('/', social);
users.route('/', profiles);
users.route('/', accountProfile);
users.route('/', security);
users.route('/', deletion);
users.route('/', avatar);
users.route('/', relationships);

export default users;
