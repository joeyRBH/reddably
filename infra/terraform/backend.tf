# Remote state for the isolated Claimsub stack.
#
# This bucket is NOT created by this configuration (chicken/egg: the backend must
# exist before `terraform init`). Create it ONCE, out-of-band, in the Claimsub AWS
# account before the first init - see README.md §Prerequisites.
#
# LOCKING: S3 native (use_lockfile), not DynamoDB. State locking used to require a
# separate DynamoDB table; Terraform 1.10+ does it with a conditional-write lock
# file (<key>.tflock) in the SAME bucket, and `dynamodb_table` is deprecated. The
# table this stack pointed at (claimsub-terraform-locks) no longer exists, so every
# apply failed acquiring the lock - one less resource to keep alive, and one less
# thing to pay for, is the right fix rather than recreating it.
#
# Switching locking changes BACKEND CONFIG, not state location: the bucket and key
# are untouched, so there is no state migration. It does require a re-init:
#
#   terraform init -reconfigure
#
# Backend config takes only literals (no variables/interpolation). If you run in
# a different account/region, override at init time with `-backend-config=...`
# instead of editing committed values.
terraform {
  backend "s3" {
    bucket       = "claimsub-terraform-state"
    key          = "claimsub/prod/terraform.tfstate"
    region       = "us-west-2"
    use_lockfile = true
    encrypt      = true
  }
}
