# Monsieur Cuisine API fixtures

Response bodies of the website proxy (`POST /proxy-api`) and the public read API, used by the client tests.

Recorded on 2026-10-13 from a member account and the web editor, then scrubbed: author, user and recipe ids, names, avatars, tag ids, media ids, translation ids, sub-object ids, media URLs, signed upload URLs and user-typed descriptions are replaced with synthetic values. No cookies were ever part of the response bodies.

| File                                     | Source                                                                |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `users.json`                             | `GET api/v1/users`, every value synthetic, keys and types as recorded |
| `recipes-list.json`                      | `GET api/v3/auth/user/recipes?...`, scrubbed                          |
| `recipe-create.json`                     | `POST api/v3/auth/user/recipes/` (HTTP 201), scrubbed                 |
| `recipe-get.json`                        | `GET api/v3/auth/user/recipes/{id}`, scrubbed                         |
| `recipe-update.json`                     | `PUT api/v3/auth/user/recipes/{id}`, scrubbed                         |
| `media-upload-url-*.json`                | `POST api/v1/media/image/upload-url` (HTTP 201), signed URL replaced  |
| `media-pending.json`, `media-ready.json` | `GET api/v1/media?ids[]=...`, first and second poll                   |
| `ingredients-quick-search.json`          | `GET api/v1/ingredients/quick-search?q=Mehl&count=20`                 |
| `categories.json`                        | `GET https://mc-api.tecpal.com/api/v1/categories` (public)            |
| `error-invalid-cookie.json`              | HTTP 401 without a cookie                                             |
| `error-bad-request.json`                 | HTTP 400 without `X-Request-ID`                                       |
| `error-expired-cookie.json`              | synthetic, from the documented code 110002                            |
| `error-validation.json`                  | message as recorded by a limit probe (HTTP 400), `data` synthetic     |
| `recipe-status.json`                     | synthetic; the real `PATCH` response was not recorded                 |
