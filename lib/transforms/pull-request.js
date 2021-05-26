// TODO - replace with library
const issueKeyParser = require('../../issueKeyParser');
const { getJiraId } = require('../jira/util/id');
const _ = require('lodash');
const { isEmpty } = require('lodash');

function mapStatus({ state, merged }) {
  if (state === 'merged') {
    return 'MERGED';
  } else if (state === 'open') {
    return 'OPEN';
  } else if (state === 'closed' && merged) {
    return 'MERGED';
  } else if (state === 'closed' && !merged) {
    return 'DECLINED';
  } else {
    return 'UNKNOWN';
  }
}

function mapReviews(reviews) {
  reviews = reviews || [];
  const sortedReviews = _.orderBy(reviews, 'submitted_at', 'desc');
  const usernames = {};

  // The reduce function goes through all the reviews and creates an array of unique users (so users' avatars won't be duplicated on the dev panel in Jira) and it considers 'APPROVED' as the main approval status for that user.
  return sortedReviews.reduce((acc, review) => {
    // Adds user to the usernames object if user is not yet added, then it adds that unique user to the accumulator.
    if (!usernames[review.user.login]) {
      usernames[review.user.login] = {
        name: review.user.login,
        approvalStatus: review.state === 'APPROVED' ? 'APPROVED' : 'UNAPPROVED',
        url: review.user.html_url,
        avatar: review.user.avatar_url,
      };
      acc.push(usernames[review.user.login]);
      // If user is already added (not unique) but the previous approval status is different than APPROVED and current approval status is APPROVED, updates approval status.
    } else if (usernames[review.user.login].approvalStatus !== 'APPROVED' && review.state === 'APPROVED') {
      usernames[review.user.login].approvalStatus = 'APPROVED';
    }
    // Returns the reviews' array with unique users
    return acc;
  }, []);
}

module.exports = (payload, author, reviews) => {
  const { pull_request: pullRequest, repository } = payload;
  const {
    title, head, updated_at: updatedAt, comments, base, number, html_url: prUrl,
  } = pullRequest;
  const { id, full_name: fullName, html_url: repoUrl } = repository;
  const { sha, repo, ref } = head;
  const { login, avatar_url: avatar, html_url: authorUrl } = author;

  // This is the same thing we do in sync, concatenating these values
  const issueKeys = issueKeyParser().parse(`${title}\n${ref}`);

  if (isEmpty(issueKeys) || !repo) {
    return { data: undefined };
  }

  const pullRequestStatus = mapStatus(pullRequest);

  let data = {
    data: {
      id,
      name: fullName,
      url: repoUrl,
      branches: [
        {
          createPullRequestUrl: `${repo.html_url}/pull/new/${ref}`,
          lastCommit: {
            author: {
              name: login,
            },
            authorTimestamp: updatedAt,
            displayId: sha.substring(0, 6),
            fileCount: 0,
            hash: sha,
            id: sha,
            issueKeys,
            message: 'n/a',
            updateSequenceId: Date.now(),
            url: `${repo.html_url}/commit/${sha}`,
          },
          id: getJiraId(ref),
          issueKeys,
          name: ref,
          url: `${repo.html_url}/tree/${ref}`,
          updateSequenceId: Date.now(),
        },
      ],
      pullRequests: [
        {
          author: {
            avatar,
            name: login,
            url: authorUrl,
          },
          commentCount: comments,
          destinationBranch: `${base.repo.html_url}/tree/${base.ref}`,
          displayId: `#${number}`,
          id: number,
          issueKeys,
          lastUpdate: updatedAt,
          reviewers: mapReviews(reviews),
          sourceBranch: ref,
          sourceBranchUrl: `${repo.html_url}/tree/${ref}`,
          status: pullRequestStatus,
          timestamp: updatedAt,
          title,
          url: prUrl,
          updateSequenceId: Date.now(),
        },
      ],
      updateSequenceId: Date.now(),
    },
  };

  // Do not send the branch on the payload when the Pull Request Merged event is called.
  // Reason: If "Automatically delete head branches" is enabled, the branch deleted and PR merged events might be sent out “at the same time” and received out of order, which causes the branch being created again.
  if (pullRequestStatus === 'MERGED') {
    data.data.branches = [];
  }

  return data;
};
