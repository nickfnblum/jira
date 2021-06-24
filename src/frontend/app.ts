import bodyParser from 'body-parser';
import express from 'express';
import { Express, NextFunction, Request, Response } from 'express';
import path from 'path';
import cookieSession from 'cookie-session';
import csrf from 'csurf';
import * as Sentry from '@sentry/node';
import hbs from 'hbs';
import GithubOAuth from './github-oauth';
import getGitHubSetup from './get-github-setup';
import postGitHubSetup from './post-github-setup';
import getGitHubConfiguration from './get-github-configuration';
import postGitHubConfiguration from './post-github-configuration';
import listGitHubInstallations from './list-github-installations';
import getGitHubSubscriptions from './get-github-subscriptions';
import deleteGitHubSubscription from './delete-github-subscription';
import getJiraConfiguration from './get-jira-configuration';
import deleteJiraConfiguration from './delete-jira-configuration';
import getGithubClientMiddleware from './github-client-middleware';
import verifyJiraMiddleware from './verify-jira-middleware';
import retrySync from './retry-sync';
import api from '../api';
import logMiddleware from '../middleware/log-middleware';
import { App } from '@octokit/app';
import statsd, { expressStatsdMetrics } from '../config/statsd';
import  expressStatsd from 'express-hot-shots';

// Adding session information to request
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body?: Record<string, any>;
      session: {
        jiraHost?: string;
        githubToken?: string;
        jwt?: string;
        [key: string]: unknown;
      };
    }
  }
}

const oauth = GithubOAuth({
  githubClient: process.env.GITHUB_CLIENT_ID,
  githubSecret: process.env.GITHUB_CLIENT_SECRET,
  baseURL: process.env.APP_URL,
  loginURI: '/github/login',
  callbackURI: '/github/callback',
});

// setup route middlewares
const csrfProtection = csrf(
  process.env.NODE_ENV === 'test'
    ? {
        ignoreMethods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'],
      }
    : undefined,
);

export default (octokitApp: App): Express => {
  const githubClientMiddleware = getGithubClientMiddleware(octokitApp);

  const app = express();
  const rootPath = path.resolve(__dirname, '..', '..');

  // The request handler must be the first middleware on the app
  app.use(Sentry.Handlers.requestHandler());

  // Parse URL-encoded bodies for Jira configuration requests
  app.use(bodyParser.urlencoded({ extended: false }));

  // We run behind ngrok.io so we need to trust the proxy always
  // TODO: look into the security of this.  Maybe should only be done for local dev?
  app.set('trust proxy', true);

  app.use(
    cookieSession({
      keys: [process.env.GITHUB_CLIENT_SECRET],
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      signed: true,
      sameSite: 'none',
      secure: true,
    }),
  );

  app.use(logMiddleware);

  // TODO: move all view/static/public/handlebars helper things in it's own folder
  app.set('view engine', 'hbs');
  app.set('views', path.join(rootPath, 'views'));

  // Handlebars helpers
  hbs.registerHelper('toLowerCase', (str) => str.toLowerCase());
  hbs.registerHelper('replaceSpaceWithHyphen', (str) => str.replace(/ /g, '-'));
  hbs.registerHelper(
    'ifAllReposSynced',
    (numberOfSyncedRepos, totalNumberOfRepos) =>
      numberOfSyncedRepos === totalNumberOfRepos
        ? totalNumberOfRepos
        : `${numberOfSyncedRepos} / ${totalNumberOfRepos}`,
  );

  app.use('/public', express.static(path.join(rootPath, 'static')));
  app.use(
    '/public/css-reset',
    express.static(
      path.join(rootPath, 'node_modules/@atlaskit/css-reset/dist'),
    ),
  );
  app.use(
    '/public/primer',
    express.static(path.join(rootPath, 'node_modules/primer/build')),
  );
  app.use(
    '/public/atlassian-ui-kit',
    express.static(
      path.join(rootPath, 'node_modules/@atlaskit/reduced-ui-pack/dist'),
    ),
  );

  // Check to see if jira host has been passed to any routes and save it to session
  app.use((req: Request, _: Response, next: NextFunction): void => {
    req.session.jwt = (req.query.jwt as string) || req.session.jwt;
    req.session.jiraHost = (req.query.xdm_e as string) || req.session.jiraHost;
    next();
  });

  app.use(githubClientMiddleware);

  app.use('/api', api);

  // Add oauth routes
  app.use('/', oauth.router);

  app.use(expressStatsd());

  app.get(
    '/github/setup',
    csrfProtection,
    oauth.checkGithubAuth,
    getGitHubSetup,
    expressStatsdMetrics('/github/setup')
  );

  app.post('/github/setup', csrfProtection, postGitHubSetup,  expressStatsdMetrics('/github/setup'));

  app.get(
    '/github/configuration',
    csrfProtection,
    oauth.checkGithubAuth,
    getGitHubConfiguration,
    expressStatsdMetrics('/github/configuration')
  );

  app.post('/github/configuration', csrfProtection, postGitHubConfiguration,  expressStatsdMetrics('/github/configuration'));

  app.get(
    '/github/installations',
    csrfProtection,
    oauth.checkGithubAuth,
    listGitHubInstallations,
    expressStatsdMetrics('/github/installations')
  );

  app.get(
    '/github/subscriptions/:installationId',
    csrfProtection,
    getGitHubSubscriptions,
    expressStatsdMetrics('/github/subscriptions/:installationId')
  );

  app.post('/github/subscription', csrfProtection, deleteGitHubSubscription,  expressStatsdMetrics('/github/subscription'));

  app.get(
    '/jira/configuration',
    csrfProtection,
    verifyJiraMiddleware,
    getJiraConfiguration,
    expressStatsdMetrics('/jira/configuration')
  );

  app.delete(
    '/jira/configuration',
    verifyJiraMiddleware,
    deleteJiraConfiguration,
    expressStatsdMetrics('/jira/configuration')
  );

  app.post('/jira/sync', verifyJiraMiddleware, retrySync, expressStatsdMetrics('/jira/sync'));

  app.get('/', async (_: Request, res: Response, next: NextFunction) => {
    const { data: info } = await res.locals.client.apps.getAuthenticated({});
    res.redirect(info.external_url);
    next();
  });

  // Add Sentry Context
  app.use((err: Error, req: Request, _: Response, next: NextFunction) => {
    Sentry.withScope((scope: Sentry.Scope): void => {
      if (req.session.jiraHost) {
        scope.setTag('jiraHost', req.session.jiraHost);
      }

      if (req.body) {
        Sentry.setExtra('Body', req.body);
      }

      next(err);
    });
  });
  // The error handler must come after controllers and before other error middleware
  app.use(Sentry.Handlers.errorHandler());

  // Error catcher - Batter up!
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    req.log.error(err, `Error in frontend app.`);

    if (process.env.NODE_ENV !== 'production') {
      return next(err);
    }

    // TODO: move this somewhere else, enum?
    const errorCodes = {
      Unauthorized: 401,
      Forbidden: 403,
      'Not Found': 404,
    };

    const tags = [
      `error: ${req.log.error}`,
      `status: ${errorCodes[err.message]}`,
    ];

    statsd.increment('github_error_rendered', tags);

    return res
      .status(errorCodes[err.message] || 400)
      .render('github-error.hbs', {
        title: 'GitHub + Jira integration',
      });
  });

  return app;
};
