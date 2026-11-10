# EmpireCommunitySite-Worker

Cloudflare Worker that publishes the EmpireCommunity member count at `https://empirecommunity.org/data/members.json`,
read by the [EmpireCommunitySite](https://github.com/EmpireCommunity/EmpireCommunitySite).

The contract lives in the site repository: [`docs/contracts/members-json.md`](https://github.com/EmpireCommunity/EmpireCommunitySite/blob/main/docs/contracts/members-json.md).

Deployed by Cloudflare Workers Builds on merge to `main`. Changes reach `main` only through pull requests.

## License

The code is under the [MIT License](LICENSE). The EmpireCommunity name and logo are not covered by it: all rights reserved.
