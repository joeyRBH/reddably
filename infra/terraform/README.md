# Claimsub backend infrastructure (Terraform)

Isolated AWS stack for the Claimsub backend — its **own** VPC + RDS, separate from
Sessionably, for clean PHI separation. Provisions everything behind
`https://api.claimsub.com`: a private VPC, an encrypted RDS PostgreSQL 16 instance,
three auth Lambdas (`register` / `login` / `me`) packaged from [`/backend`](../../backend),
an API Gateway HTTP API, and the ACM cert + custom domain.

> Mirrors the Sessionably Terraform conventions (flat file-per-concern layout,
> `~> 5.0` AWS provider, SSM placeholder + `ignore_changes` for secrets, two-phase
> custom domain). This stack is fully self-contained — it does **not** touch or
> reference the Sessionably account, VPC, or RDS.

## File map

| File              | Concern                                                            |
| ----------------- | ----------------------------------------------------------------- |
| `providers.tf`    | Terraform + AWS/archive provider versions, default tags           |
| `backend.tf`      | S3 remote state (bucket/lock table created out-of-band first)     |
| `variables.tf`    | All inputs (+ `terraform.tfvars.example`)                         |
| `locals.tf`       | Name prefix, SSM namespace, the register/login/me function map    |
| `data.tf`         | Account/region/partition/AZ lookups                              |
| `network.tf`      | VPC, two private subnets, route table, Lambda SG + RDS SG         |
| `database.tf`     | RDS PostgreSQL 16 (encrypted, private, backups on)                |
| `ssm.tf`          | SecureString params for `DATABASE_URL`, `JWT_SECRET`, master pw   |
| `iam.tf`          | Least-privilege Lambda execution role                            |
| `lambda.tf`       | The three auth functions + log groups + `/backend` zip           |
| `migrate.tf`      | One-off `claimsub-prod-migrate` Lambda (applies `db/schema.sql`)  |
| `vpc-endpoints.tf`| Optional SSM interface endpoint (runtime SSM reads, no NAT)       |
| `api.tf`          | HTTP API, routes, CORS, access logs, invoke permissions          |
| `api-domain.tf`   | ACM cert request + (phase 2) custom domain + base-path mapping    |
| `outputs.tf`      | IDs, endpoints, ACM validation records, custom-domain target      |
| `deploy.sh`       | `terraform apply` + automatic Lambda secret hydration from SSM     |

---

## Prerequisites

1. **AWS credentials** for the **Claimsub** account (a different account or at
   least a clean, isolated set of resources from Sessionably). Export a profile:
   ```bash
   export AWS_PROFILE=claimsub-prod
   export AWS_REGION=us-west-2          # must match backend.tf + var.aws_region
   ```
2. **Terraform** `>= 1.7` (developed on 1.14).
3. **Remote state backend** — create these once, out-of-band, before the first
   `terraform init` (they can't be managed by this config — chicken/egg):
   ```bash
   aws s3api create-bucket \
     --bucket claimsub-terraform-state \
     --region us-west-2 \
     --create-bucket-configuration LocationConstraint=us-west-2
   aws s3api put-bucket-versioning \
     --bucket claimsub-terraform-state \
     --versioning-configuration Status=Enabled
   aws s3api put-bucket-encryption \
     --bucket claimsub-terraform-state \
     --server-side-encryption-configuration \
       '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
   aws dynamodb create-table \
     --table-name claimsub-terraform-locks \
     --attribute-definitions AttributeName=LockID,AttributeType=S \
     --key-schema AttributeName=LockID,KeyType=HASH \
     --billing-mode PAY_PER_REQUEST
   ```
   If you use different names/region, override at init with
   `terraform init -backend-config=backend.hcl` instead of editing `backend.tf`.
4. **Package the Lambda artifact** — install backend deps so `node_modules` is
   present; `archive_file` zips `/backend` at plan time:
   ```bash
   cd ../../backend && npm ci --omit=dev && cd -
   ```
   Use `npm ci` (not `npm install`) so the install exactly matches the committed
   `backend/package-lock.json`. Neither `node_modules` nor
   `.build/claimsub-backend.zip` is committed — which is why this step is
   **mandatory on every fresh checkout**: `archive_file` zips whatever is on
   disk, and a deploy from a clone without `node_modules` shipped
   dependency-less zips that failed every Lambda at cold start with
   `MODULE_NOT_FOUND` (prod outage, 2026-08-03). Two safety nets now exist:
   `lambda.tf` preconditions fail `terraform plan`/`apply` fast if
   `node_modules` is missing or stale relative to the lockfile, and
   `./deploy.sh` runs the `npm ci` automatically before applying.

---

## Configuration

```bash
cp terraform.tfvars.example terraform.tfvars
# edit if your region/CIDRs/sizing differ from the defaults
terraform init        # configures the S3 backend
```

Do **not** put the RDS master password in `terraform.tfvars`. It is supplied via
`TF_VAR_db_master_password`, sourced from SSM (see next section).

---

## Secrets (set out-of-band — never committed)

Three SecureString parameters are **declared** by `ssm.tf` with placeholder values
and `ignore_changes = [value]`, so Terraform creates them once and never reads or
overwrites the live value. **You** set the real values with the AWS CLI:

> SSM is the canonical store. The Lambdas' `DATABASE_URL` / `JWT_SECRET` env vars are
> hydrated **from** these parameters automatically by `./deploy.sh` (see §Hydrate
> Lambda env) — the secret values never enter `tfstate`, tfvars, or git.


| Parameter                          | Value                                                        |
| ---------------------------------- | ------------------------------------------------------------ |
| `/claimsub/prod/DB_MASTER_PASSWORD`| Strong random password for the RDS master user               |
| `/claimsub/prod/DATABASE_URL`      | `postgres://USER:PASS@<rds-endpoint>:5432/claimsub`          |
| `/claimsub/prod/JWT_SECRET`        | `openssl rand -hex 32`                                       |

The SSM parameters don't exist until the **ssm** apply step (step 3) runs, but RDS
(step 2) needs the master password earlier. So on the **first** bring-up you
generate the password locally, pass it to the db apply via `TF_VAR`, and then seed
SSM as its canonical home in step 3. The password never lands in a file or in git —
only in the encrypted S3 state.

```bash
# First bring-up: generate the master password once and export it for the db apply.
export TF_VAR_db_master_password="$(openssl rand -base64 30 | tr -d '/+=')"
```

After the **ssm** step creates the parameters (step 3), seed all three SecureStrings
as the canonical store:

```bash
# Master password — same value RDS was created with:
aws ssm put-parameter --name /claimsub/prod/DB_MASTER_PASSWORD \
  --type SecureString --overwrite --value "$TF_VAR_db_master_password"

# JWT secret:
aws ssm put-parameter --name /claimsub/prod/JWT_SECRET \
  --type SecureString --overwrite --value "$(openssl rand -hex 32)"

# DATABASE_URL — needs the RDS endpoint, so set it after the db apply:
aws ssm put-parameter --name /claimsub/prod/DATABASE_URL \
  --type SecureString --overwrite \
  --value "postgres://claimsub_admin:${TF_VAR_db_master_password}@$(terraform output -raw db_address):5432/claimsub"
```

On **every later apply**, source the master password back from SSM (its canonical
home) instead of regenerating it:

```bash
export TF_VAR_db_master_password="$(aws ssm get-parameter \
  --name /claimsub/prod/DB_MASTER_PASSWORD --with-decryption \
  --query Parameter.Value --output text)"
```

---

## Apply order

The stack is a single root module. Use `-target` to bring it up in dependency
order on the first run; afterwards a plain `terraform apply` reconciles everything.

```bash
# 1. NETWORK — VPC, subnets, route table, security groups
terraform apply \
  -target=aws_vpc.main \
  -target=aws_subnet.private \
  -target=aws_route_table.private \
  -target=aws_route_table_association.private \
  -target=aws_security_group.lambda \
  -target=aws_security_group.rds \
  -target=aws_vpc_security_group_egress_rule.lambda_to_rds \
  -target=aws_vpc_security_group_ingress_rule.rds_from_lambda

# 2. DB — RDS subnet group + instance.
#    First bring-up: export the generated master password (see §Secrets) first:
#      export TF_VAR_db_master_password="$(openssl rand -base64 30 | tr -d '/+=')"
terraform apply \
  -target=aws_db_subnet_group.main \
  -target=aws_db_instance.main

# 3. SSM — create the SecureString parameters, then seed their values out-of-band
terraform apply -target=aws_ssm_parameter.secure
#    → now run the three put-parameter commands from §Secrets (DB_MASTER_PASSWORD,
#      JWT_SECRET, and DATABASE_URL — the last uses `terraform output -raw db_address`).

# 4. LAMBDA — the three functions, log groups, IAM
#    First: build the backend zip (deps + bundle the schema for the migrate Lambda):
#      (cd ../../backend && npm ci --omit=dev && npm run bundle:schema)
terraform apply \
  -target=aws_iam_role.lambda_exec \
  -target=aws_iam_role_policy.lambda_runtime \
  -target=aws_iam_role_policy_attachment.lambda_vpc \
  -target=aws_cloudwatch_log_group.lambda \
  -target=aws_lambda_function.auth
#    → env hydration is automatic on the full `./deploy.sh` run below (see §Hydrate Lambda env)

# 5. API — HTTP API, routes, CORS, access logs, invoke permissions
terraform apply \
  -target=aws_apigatewayv2_api.http \
  -target=aws_apigatewayv2_integration.auth \
  -target=aws_apigatewayv2_route.auth \
  -target=aws_apigatewayv2_stage.default \
  -target=aws_cloudwatch_log_group.apigw_access \
  -target=aws_lambda_permission.apigw

# 6. DOMAIN — request the ACM cert (custom domain comes in phase 2; see §DNS repoint)
terraform apply -target=aws_acm_certificate.api

# Finally, reconcile the whole stack and hydrate the Lambdas from SSM
# (also keep TF_VAR_db_master_password exported):
./deploy.sh
```

> The `-target` runs are only needed for the **first** bring-up because of the
> out-of-band secret steps between phases. Day-to-day, just run `./deploy.sh`
> (it wraps `terraform apply` and hydrates the Lambda env from SSM).

---

## Hydrate Lambda env from SSM

The `/backend` handlers read `process.env.DATABASE_URL` / `process.env.JWT_SECRET`
directly (do **not** modify `/backend`). Terraform creates each function with
placeholder env values and `ignore_changes = [environment]`, so the real values
have to be injected from SSM after apply — and Terraform won't revert them.

**This is now automatic.** Instead of `terraform apply`, deploy with:

```bash
./deploy.sh            # runs `terraform apply`, then hydrates every Lambda from SSM
# extra args pass straight through to terraform apply, e.g.
./deploy.sh -auto-approve
```

`deploy.sh` runs `terraform apply`, then reads the `lambda_function_names` and
`ssm_secure_parameter_names` outputs, fetches the decrypted `DATABASE_URL` /
`JWT_SECRET` from SSM, and writes them into each function's env config. It is
**idempotent** — a function already holding the current values is skipped — and it
writes **no secret values to tfstate** (secrets live only in SSM and each
function's env config). Re-running it after a secret rotation or connection-string
change re-hydrates every function. It honours `AWS_PROFILE` / `AWS_REGION` (defaults
`claimsub-prod` / `us-west-2`) and requires `jq`.

The deploy principal needs, in addition to the usual Terraform permissions:

- `ssm:GetParameter` + `kms:Decrypt` — to read the SecureString values (already
  granted to the Lambda execution role in `iam.tf`; the principal running
  `deploy.sh` needs them too).
- `lambda:GetFunctionConfiguration` + `lambda:UpdateFunctionConfiguration` — to read
  and inject each function's environment.

> The manual `aws lambda update-function-configuration` loop that used to live here is
> retired — `./deploy.sh` does it for you.

---

## Apply the database schema to private RDS

RDS is `publicly_accessible = false` and only reachable from inside the VPC, so
you can't connect from your laptop directly. **Chosen approach: the one-off
`claimsub-prod-migrate` Lambda** (`migrate.tf` / `backend/handlers/migrate.js`) —
it runs inside the VPC, reads `DATABASE_URL` from SSM at runtime (via the SSM
interface endpoint in `vpc-endpoints.tf`), and applies `db/schema.sql`. No bastion,
no public DB access. `schema.sql` is idempotent, so it is safe to invoke repeatedly.

Prerequisites (already covered by the apply order above):

- The DB exists and `/claimsub/prod/DATABASE_URL` is seeded (apply steps 2–3).
- The backend zip was built with the schema bundled in:
  `(cd ../../backend && npm ci --omit=dev && npm run bundle:schema)`.
- `create_ssm_vpc_endpoint = true` (default) so the Lambda can reach SSM.

Apply the migrate resources, then invoke:

```bash
# Bring up the SSM endpoint + the migrate Lambda (part of the full apply too):
terraform apply \
  -target=aws_vpc_endpoint.ssm \
  -target=aws_security_group.ssm_endpoint \
  -target=aws_vpc_security_group_ingress_rule.ssm_endpoint_from_lambda \
  -target=aws_vpc_security_group_egress_rule.lambda_to_ssm_endpoint \
  -target=aws_cloudwatch_log_group.migrate \
  -target=aws_lambda_function.migrate

# Apply the schema (idempotent — safe to re-run):
aws lambda invoke --function-name claimsub-prod-migrate /tmp/out.json && cat /tmp/out.json
# -> {"ok":true,"message":"Schema applied successfully."}
```

A non-`ok` result prints the error in `message`; check the function's CloudWatch
log group (`/aws/lambda/claimsub-prod-migrate`) for detail. The connection string
is never logged.

> Cost note: the SSM interface endpoint bills hourly per AZ. Once the schema is
> applied you may set `create_ssm_vpc_endpoint = false` and re-apply to destroy it;
> the migrate Lambda then can't reach SSM until you recreate it.

---

## DNS repoint (manual — Vercel → API Gateway)

Today `api.claimsub.com` is parked on Vercel and returns `DEPLOYMENT_NOT_FOUND`.
Terraform models the cert + custom domain but **does not** manage any DNS records.
The domain comes up in two phases:

**Phase 1 — cert request (already done in apply step 6).** Read the validation
records and add them at your DNS provider:
```bash
terraform output acm_validation_records
```
For each entry, create the `CNAME` (`name` → `value`) at the registrar/DNS host
for `claimsub.com`. Wait for the cert to reach **ISSUED**:
```bash
aws acm describe-certificate \
  --certificate-arn "$(terraform output -raw acm_certificate_arn)" \
  --query 'Certificate.Status'
```

**Phase 2 — custom domain + repoint.** Once ISSUED:
```bash
terraform apply -var=create_api_custom_domain=true   # (keep TF_VAR_db_master_password exported)
terraform output api_custom_domain_target            # e.g. d-abc123.execute-api.us-west-2.amazonaws.com
```
Then, at the DNS provider:
1. **Remove** the existing `api.claimsub.com` record pointing at Vercel.
2. **Add** `api.claimsub.com` → the `api_custom_domain_target` hostname
   (a `CNAME`; or a Route53 `ALIAS` using `api_custom_domain_hosted_zone_id`).

Verify end-to-end:
```bash
curl -i https://api.claimsub.com/login -X POST \
  -H 'content-type: application/json' -d '{}'    # expect 400/401 JSON, not a Vercel 404
```

> Until the custom domain is live, smoke-test against the default endpoint:
> `terraform output api_endpoint` (e.g. `POST <api_endpoint>/register`).

---

## Register the first practice admin

Once the API is live (default endpoint or custom domain) and the schema is applied,
bootstrap the first practice + admin via `POST /register` with `mode:"new_practice"`:

```bash
curl -i https://api.claimsub.com/register -X POST \
  -H 'content-type: application/json' \
  -d '{
        "mode": "new_practice",
        "practice_name": "Your Practice Name",
        "email": "admin@yourpractice.com",
        "password": "a-long-strong-password",
        "first_name": "Ada",
        "last_name": "Admin"
      }'
```

A `201 { token, user }` confirms the stack is wired end-to-end: the practice row,
the `practice_admin` user, and a signed JWT. Log in afterward with `POST /login`,
and call `GET /me` with `Authorization: Bearer <token>` to confirm auth round-trips.

---

## Security / HIPAA notes

- **PHI isolation** — dedicated VPC + RDS, no peering to Sessionably.
- **No app internet path** — no IGW, no NAT. The auth Lambdas reach only RDS (5432).
  CloudWatch Logs delivery doesn't traverse the function ENI, so logging still works.
  The only other egress is an optional SSM **interface** endpoint (still no NAT, still
  no internet) the migrate Lambda uses to read `DATABASE_URL`; destroy it after
  migrating with `create_ssm_vpc_endpoint = false` if you prefer the minimal surface.
- **Encryption** — RDS `storage_encrypted = true` (default `aws/rds` key or a CMK);
  SSM SecureStrings; in transit via TLS (`sslmode=require` / pg `ssl`).
- **Least privilege** — RDS SG accepts 5432 only from the Lambda SG; the Lambda role
  can read only `/claimsub/<env>/*` SSM params and write only its own log groups.
- **No secrets in git** — only `terraform.tfvars.example` is tracked (placeholders).
  Real values live in SSM / the encrypted S3 state, never the repo.
- **Backups** — automated backups on (14-day default), deletion protection on,
  final snapshot on destroy.
