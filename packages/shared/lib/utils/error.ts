export class NangoError extends Error {
    public readonly status: number;
    public readonly type: string;
    public payload: { [key: string]: unknown };
    public override readonly message: string;

    constructor(type: string, payload = {}) {
        super();

        this.type = type;
        this.payload = payload;

        switch (type) {
            case 'missing_auth_header':
                this.status = 401;
                this.message = 'Authentication failed. The request is missing the Authorization header.';
                break;

            case 'malformed_auth_header':
                this.status = 401;
                this.message = 'Authentication failed. The Authorization header is malformed.';
                break;

            case 'unkown_account':
                this.status = 401;
                this.message = 'Authentication failed. The provided secret/public key does not match any account.';
                break;

            case 'invalid_secret_key':
                this.status = 401;
                this.message = 'Authentication failed. The provided secret key is invalid.';
                break;

            case 'invalid_secret_key_format':
                this.status = 401;
                this.message = 'Authentication failed. The provided secret key is not a UUID v4.';
                break;

            case 'missing_public_key':
                this.status = 401;
                this.message = 'Authentication failed. The request is missing a valid public key parameter.';
                break;

            case 'invalid_public_key':
                this.status = 401;
                this.message = 'Authentication failed. The provided public key is not a UUID v4.';
                break;

            case 'only_nango_cloud':
                this.status = 401;
                this.message = 'This endpoint is only available for Nango Cloud.';
                break;

            case 'invalid_admin_key':
                this.status = 401;
                this.message = 'Authentication failed. The provided admin key is invalid.';
                break;

            case 'admin_key_configuration':
                this.status = 401;
                this.message = 'The admin key is not configured on the server. Contact the API provider.';
                break;

            case 'missing_body':
                this.status = 400;
                this.message = 'Missing request body.';
                break;

            case 'missing_email_param':
                this.status = 400;
                this.message = `Missing parameter 'email'.`;
                break;

            case 'missing_name_param':
                this.status = 400;
                this.message = `Missing parameter 'name'.`;
                break;

            case 'missing_password_param':
                this.status = 400;
                this.message = `Missing parameter 'password'.`;
                break;

            case 'duplicate_account':
                this.status = 400;
                this.message = 'Email already exists.';
                break;

            case 'unkown_user':
                this.status = 404;
                this.message = 'No user matching this email.';
                break;

            case 'unknown_endpoint':
                this.status = 404;
                this.message = 'The API endpoint could not be found and returned a 404. Please ensure you have the endpoint specified and spelled correctly.';
                break;

            case 'fobidden':
                this.status = 403;
                this.message = 'The API endpoint returned back a 403 error. Check the scopes requested to make sure proper access is requested to the API.';
                break;

            case 'bad_request':
                this.status = 400;
                this.message = 'The API endpoint returned back a 400 error. Check the headers to ensure all proper headers are passed to the API.';
                break;

            case 'missing_provider_config':
                this.status = 400;
                this.message = `Missing param 'provider_config_key'.`;
                break;

            case 'missing_callback_url':
                this.status = 400;
                this.message = `Missing param 'callback_url'.`;
                break;

            case 'unknown_provider_config':
                this.status = 400;
                this.message = `There is no Provider Configuration matching this key.`;
                if (this.payload) {
                    this.message += ` Please make sure this value exists in the Nango dashboard ${JSON.stringify(this.payload, null, 2)}`;
                }
                break;

            case 'missing_provider_template':
                this.status = 400;
                this.message = `Missing param 'provider'.`;
                break;

            case 'missing_client_id':
                this.status = 400;
                this.message = `Missing param 'oauth_client_id'.`;
                break;

            case 'missing_client_secret':
                this.status = 400;
                this.message = `Missing param 'oauth_client_secret'.`;
                break;

            case 'missing_scopes':
                this.status = 400;
                this.message = `Missing param 'oauth_scopes'.`;
                break;

            case 'missing_connection':
                this.status = 400;
                this.message = `Missing param 'connection_id'.`;
                break;

            case 'unkown_connection':
                this.status = 400;
                this.message = `No connection matching the provided params of 'connection_id' and 'provider_config_key'.`;
                if (this.payload) {
                    this.message += ` Please make sure these values exist in the Nango dashboard ${JSON.stringify(this.payload, null, 2)}`;
                }
                break;

            case 'refresh_token_external_error':
                this.status = 400;
                this.message = `The external API returned an error when trying to refresh the access token. Please try again later.`;
                if (this.payload) {
                    this.message += ` ${JSON.stringify(this.payload, null, 2)}`;
                }
                break;

            case 'connection_already_exists':
                this.status = 409;
                this.message = 'A connection already exists for this provider configuration.';
                break;

            case 'missing_base_api_url':
                this.status = 400;
                this.message =
                    'The proxy is not supported for the provider. You can easily add support by following the instructions at https://docs.nango.dev/contribute-api';
                break;

            case 'unknown_provider_template':
                this.status = 400;
                this.message = `No Provider Template matching the 'provider' parameter.`;
                break;

            case 'duplicate_provider_config':
                this.status = 400;
                this.message = `There is already a Provider Configuration matching the param 'provider_config_key'.`;
                break;

            case 'missing_password_reset_token':
                this.status = 400;
                this.message = 'Missing reset token (or password).';
                break;

            case 'unkown_password_reset_token':
                this.status = 404;
                this.message = 'Reset password token expired on unknown.';
                break;

            case 'missing_required_fields_on_deploy':
                this.status = 400;
                this.message = 'Sync name, provider config key, the file, the models, and the runs fields are required to deploy a sync';
                break;

            case 'file_upload_error':
                this.status = 400;
                this.message = 'Error uploading file. Please contact support with the filename and connection details';
                break;

            case 'empty_insert_data_on_deploy':
                this.status = 400;
                this.message = 'The data to insert for a deploy is empty. Please try again or reach out to support with the sync name and connection details';
                break;

            case 'error_creating_sync_config':
                this.status = 400;
                this.message = 'Error creating sync config from a deploy. Please contact support with the sync name and connection details';
                break;

            default:
                this.status = 500;
                this.type = 'unhandled_' + type;
                this.message = `An unhandled error has occurred: ${type}`;
        }
    }

    public setPayload(payload: any) {
        this.payload = payload;
    }
}
