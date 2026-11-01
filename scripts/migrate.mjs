import { createApp } from '../src/app.js';

const app = await createApp();
app.locals.close();
console.info('Moderation migrations applied');
