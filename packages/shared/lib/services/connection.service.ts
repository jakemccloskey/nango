import type { Response } from 'express';
import db from '../db/database.js';
import analytics from '../utils/analytics.js';
import providerClientManager from '../clients/provider.client.js';
import type {
    TemplateOAuth2 as ProviderTemplateOAuth2,
    Template as ProviderTemplate,
    Config as ProviderConfig,
    AuthCredentials,
    OAuth1Credentials,
    CredentialsRefresh,
    LogAction
} from '../models/index.js';
import {
    updateAction as updateActivityLogAction,
    createActivityLogMessage,
    createActivityLogMessageAndEnd,
    updateProvider as updateProviderActivityLog
} from '../services/activity.service.js';
import connectionService from '../services/connection.service.js';
import providerClient from '../clients/provider.client.js';
import configService from '../services/config.service.js';
import { deleteScheduleForConnection as deleteSyncScheduleForConnection } from '../services/sync/schedule.service.js';
import { getFreshOAuth2Credentials } from '../clients/oauth2.client.js';
import { NangoError } from '../utils/error.js';

import type { Connection, StoredConnection, BaseConnection, NangoConnection } from '../models/Connection.js';
import encryptionManager from '../utils/encryption.manager.js';
import { AuthModes as ProviderAuthModes, OAuth2Credentials, ImportedCredentials } from '../models/Auth.js';
import { schema } from '../db/database.js';
import { getAccount, parseTokenExpirationDate, isTokenExpired } from '../utils/utils.js';
import SyncClient from '../clients/sync.client.js';
import errorManager from '../utils/error.manager.js';

class ConnectionService {
    private runningCredentialsRefreshes: CredentialsRefresh[] = [];

    public async upsertConnection(
        connectionId: string,
        providerConfigKey: string,
        provider: string,
        parsedRawCredentials: AuthCredentials,
        connectionConfig: Record<string, string>,
        accountId: number,
        metadata: Record<string, string>
    ) {
        const id = await db.knex
            .withSchema(db.schema())
            .from<StoredConnection>(`_nango_connections`)
            .insert(
                encryptionManager.encryptConnection({
                    connection_id: connectionId,
                    provider_config_key: providerConfigKey,
                    credentials: parsedRawCredentials,
                    connection_config: connectionConfig,
                    account_id: accountId,
                    metadata: metadata
                }),
                ['id']
            )
            .onConflict(['provider_config_key', 'connection_id', 'account_id'])
            .merge();

        analytics.track('server:connection_upserted', accountId, { provider });

        return id;
    }

    public async importConnection(connection_id: string, provider_config_key: string, accountId: number, parsedRawCredentials: ImportedCredentials) {
        const provider = await configService.getProviderName(provider_config_key);

        if (!provider) {
            throw new NangoError('unknown_provider_config');
        }

        let connection = undefined;
        try {
            connection = await this.getConnection(connection_id, provider_config_key, accountId);
        } catch {}

        if (connection) {
            throw new NangoError('connection_already_exists');
        }

        const { connection_config, metadata } = parsedRawCredentials as Partial<Pick<BaseConnection, 'metadata' | 'connection_config'>>;

        const importedConnection = await this.upsertConnection(
            connection_id,
            provider_config_key,
            provider,
            parsedRawCredentials,
            connection_config as Record<string, string>,
            accountId,
            metadata as Record<string, string>
        );

        if (importedConnection) {
            const syncClient = await SyncClient.getInstance();
            syncClient?.initiate(importedConnection[0].id);
        }

        return importedConnection;
    }

    public async getConnectionById(
        id: number
    ): Promise<Pick<Connection, 'id' | 'connection_id' | 'provider_config_key' | 'account_id' | 'connection_config' | 'metadata' | 'field_mappings'> | null> {
        const result = await schema()
            .select('id', 'connection_id', 'provider_config_key', 'account_id', 'connection_config', 'metadata', 'field_mappings')
            .from<StoredConnection>('_nango_connections')
            .where({ id: id });

        if (!result || result.length == 0 || !result[0]) {
            return null;
        }

        return result[0];
    }

    public async getConnection(connectionId: string, providerConfigKey: string, accountId: number): Promise<Connection | null> {
        const result: StoredConnection[] | null = (await schema()
            .select('*')
            .from<StoredConnection>(`_nango_connections`)
            .where({ connection_id: connectionId, provider_config_key: providerConfigKey, account_id: accountId })) as unknown as StoredConnection[];

        const storedConnection = result == null || result.length == 0 ? null : result[0] || null;

        if (!storedConnection) {
            throw new NangoError('unkown_connection', { connectionId, providerConfigKey });
        }

        const connection = encryptionManager.decryptConnection(storedConnection);

        // Parse the token expiration date.
        if (connection != null && connection.credentials.type === ProviderAuthModes.OAuth2) {
            const creds = connection.credentials as OAuth2Credentials;
            creds.expires_at = creds.expires_at != null ? parseTokenExpirationDate(creds.expires_at) : undefined;
            connection.credentials = creds;
        }

        return connection;
    }

    public async updateConnection(connection: Connection) {
        await db.knex
            .withSchema(db.schema())
            .from<StoredConnection>(`_nango_connections`)
            .where({ connection_id: connection.connection_id, provider_config_key: connection.provider_config_key, account_id: connection.account_id })
            .update(encryptionManager.encryptConnection(connection));
    }

    public async getFieldMappings(connection: Connection): Promise<Record<string, string>> {
        const result = await db.knex
            .withSchema(db.schema())
            .from<StoredConnection>(`_nango_connections`)
            .select('field_mappings')
            .where({ connection_id: connection.connection_id, provider_config_key: connection.provider_config_key, account_id: connection.account_id });

        if (!result || result.length == 0 || !result[0]) {
            return {};
        }

        return result[0].field_mappings;
    }

    public async getConnectionsByAccountAndConfig(accountId: number, providerConfigKey: string): Promise<NangoConnection[]> {
        const result = await db.knex
            .withSchema(db.schema())
            .from<StoredConnection>(`_nango_connections`)
            .select('id', 'connection_id', 'provider_config_key', 'account_id')
            .where({ account_id: accountId, provider_config_key: providerConfigKey });

        if (!result || result.length == 0 || !result[0]) {
            return [];
        }

        return result;
    }

    public async updateFieldMappings(connection: Connection, fieldMappings: Record<string, string>) {
        await db.knex
            .withSchema(db.schema())
            .from<StoredConnection>(`_nango_connections`)
            .where({ id: connection.id as number })
            .update({ field_mappings: fieldMappings });
    }

    async listConnections(accountId: number, connectionId?: string): Promise<{ id: number; connection_id: number; provider: string; created: string }[]> {
        const queryBuilder = db.knex
            .withSchema(db.schema())
            .from<Connection>(`_nango_connections`)
            .select({ id: 'id' }, { connection_id: 'connection_id' }, { provider: 'provider_config_key' }, { created: 'created_at' })
            .where({ account_id: accountId });
        if (connectionId) {
            queryBuilder.where({ connection_id: connectionId });
        }
        return queryBuilder;
    }

    async deleteConnection(connection: Connection, providerConfigKey: string, accountId: number): Promise<number> {
        if (connection) {
            await deleteSyncScheduleForConnection(connection);
        }

        return await db.knex
            .withSchema(db.schema())
            .from<Connection>(`_nango_connections`)
            .where({ connection_id: connection.connection_id, provider_config_key: providerConfigKey, account_id: accountId })
            .del();
    }

    public async getConnectionCredentials(
        res: Response,
        connectionId: string,
        providerConfigKey: string,
        activityLogId?: number | null,
        action?: LogAction,
        instantRefresh = false
    ) {
        const accountId = getAccount(res);

        if (connectionId === null) {
            errorManager.errRes(res, 'missing_connection');
            return;
        }

        if (providerConfigKey === null) {
            errorManager.errRes(res, 'missing_provider_config');
            return;
        }

        const connection: Connection | null = await connectionService.getConnection(connectionId, providerConfigKey, accountId);

        if (connection === null && activityLogId) {
            await createActivityLogMessageAndEnd({
                level: 'error',
                activity_log_id: activityLogId,
                content: `Connection not found using connectionId: ${connectionId} and providerConfigKey: ${providerConfigKey}`,
                timestamp: Date.now()
            });

            errorManager.errRes(res, 'unkown_connection');
            throw new Error(`Connection not found`);
        }

        const config: ProviderConfig | null = await configService.getProviderConfig(connection?.provider_config_key as string, accountId);

        if (activityLogId) {
            await updateProviderActivityLog(activityLogId, config?.provider as string);
        }

        if (config === null && activityLogId) {
            await createActivityLogMessageAndEnd({
                level: 'error',
                activity_log_id: activityLogId,
                content: `Configuration not found using the providerConfigKey: ${providerConfigKey} and the account id: ${accountId}`,
                timestamp: Date.now()
            });

            errorManager.errRes(res, 'unknown_provider_config');
            throw new Error(`Provider config not found`);
        }

        const template: ProviderTemplate | undefined = configService.getTemplate(config?.provider as string);

        if (connection?.credentials.type === ProviderAuthModes.OAuth2) {
            connection.credentials = await connectionService.refreshOauth2CredentialsIfNeeded(
                connection,
                config as ProviderConfig,
                template as ProviderTemplateOAuth2,
                activityLogId,
                instantRefresh,
                action
            );
        }

        analytics.track('server:connection_fetched', accountId, { provider: config?.provider });

        return connection;
    }

    // Parses and arbitrary object (e.g. a server response or a user provided auth object) into AuthCredentials.
    // Throws if values are missing/missing the input is malformed.
    public parseRawCredentials(rawCredentials: object, authMode: ProviderAuthModes): AuthCredentials {
        const rawCreds = rawCredentials as Record<string, any>;

        switch (authMode) {
            case ProviderAuthModes.OAuth2:
                if (!rawCreds['access_token']) {
                    throw new NangoError(`incomplete_raw_credentials`);
                }

                let expiresAt: Date | undefined;

                if (rawCreds['expires_at']) {
                    expiresAt = parseTokenExpirationDate(rawCreds['expires_at']);
                } else if (rawCreds['expires_in']) {
                    expiresAt = new Date(Date.now() + Number.parseInt(rawCreds['expires_in'], 10) * 1000);
                }

                const oauth2Creds: OAuth2Credentials = {
                    type: ProviderAuthModes.OAuth2,
                    access_token: rawCreds['access_token'],
                    refresh_token: rawCreds['refresh_token'],
                    expires_at: expiresAt,
                    raw: rawCreds
                };

                return oauth2Creds;
            case ProviderAuthModes.OAuth1:
                if (!rawCreds['oauth_token'] || !rawCreds['oauth_token_secret']) {
                    throw new NangoError(`incomplete_raw_credentials`);
                }

                const oauth1Creds: OAuth1Credentials = {
                    type: ProviderAuthModes.OAuth1,
                    oauth_token: rawCreds['oauth_token'],
                    oauth_token_secret: rawCreds['oauth_token_secret'],
                    raw: rawCreds
                };

                return oauth1Creds;

            default:
                throw new NangoError(`Cannot parse credentials, unknown credentials type: ${JSON.stringify(rawCreds, undefined, 2)}`);
        }
    }

    // Checks if the OAuth2 credentials need to be refreshed and refreshes them if neccessary.
    // If credentials get refreshed it also updates the user's connection object.
    // Once the refresh or check is complete the new/old credentials are returned, always use these moving forward
    public async refreshOauth2CredentialsIfNeeded(
        connection: Connection,
        providerConfig: ProviderConfig,
        template: ProviderTemplateOAuth2,
        activityLogId = null as number | null,
        instantRefresh = false,
        logAction: LogAction = 'token'
    ): Promise<OAuth2Credentials> {
        const connectionId = connection.connection_id;
        const credentials = connection.credentials as OAuth2Credentials;
        const providerConfigKey = connection.provider_config_key;

        // Check if a refresh is already running for this user & provider configuration
        // If it is wait for that to complete
        let runningRefresh: CredentialsRefresh | undefined = undefined;
        for (const refresh of this.runningCredentialsRefreshes) {
            if (refresh.connectionId === connectionId && refresh.providerConfigKey === providerConfigKey) {
                runningRefresh = refresh;
            }
        }

        if (runningRefresh) {
            return runningRefresh.promise;
        }

        const refresh =
            instantRefresh ||
            (providerClient.shouldIntrospectToken(providerConfig.provider) && (await providerClient.introspectedTokenExpired(providerConfig, connection)));
        // If not expiration date is set, e.g. Github, we assume the token doesn't expire (unless introspection enable like Salesforce).
        if (
            credentials.refresh_token &&
            (refresh || (credentials.expires_at && isTokenExpired(credentials.expires_at, template.token_expiration_buffer || 15 * 60)))
        ) {
            const promise = new Promise<OAuth2Credentials>(async (resolve, reject) => {
                try {
                    let newCredentials: OAuth2Credentials;

                    if (providerClientManager.shouldUseProviderClient(providerConfig.provider)) {
                        const rawCreds = await providerClientManager.refreshToken(template, providerConfig, connection);
                        newCredentials = this.parseRawCredentials(rawCreds, ProviderAuthModes.OAuth2) as OAuth2Credentials;
                    } else {
                        newCredentials = await getFreshOAuth2Credentials(connection, providerConfig, template as ProviderTemplateOAuth2);
                    }

                    connection.credentials = newCredentials;

                    await this.updateConnection(connection);

                    // Remove ourselves from the array of running refreshes
                    this.runningCredentialsRefreshes = this.runningCredentialsRefreshes.filter((value) => {
                        return !(value.providerConfigKey === providerConfigKey && value.connectionId === connectionId);
                    });

                    resolve(newCredentials);
                } catch (e) {
                    // Remove ourselves from the array of running refreshes
                    this.runningCredentialsRefreshes = this.runningCredentialsRefreshes.filter((value) => {
                        return !(value.providerConfigKey === providerConfigKey && value.connectionId === connectionId);
                    });

                    if (activityLogId && logAction === 'token') {
                        await updateActivityLogAction(activityLogId as unknown as number, 'token');

                        await createActivityLogMessage({
                            level: 'error',
                            activity_log_id: activityLogId as number,
                            content: `Refresh oauth2 token call failed`,
                            timestamp: Date.now()
                        });
                    }
                    reject(e);
                }
            });

            const refresh = {
                connectionId: connectionId,
                providerConfigKey: providerConfigKey,
                promise: promise
            } as CredentialsRefresh;

            if (activityLogId && logAction === 'token') {
                await updateActivityLogAction(activityLogId as unknown as number, 'token');

                await createActivityLogMessage({
                    level: 'info',
                    activity_log_id: activityLogId as number,
                    content: `Token was refreshed for ${providerConfigKey} and connection ${connectionId}`,
                    timestamp: Date.now()
                });
            }
            this.runningCredentialsRefreshes.push(refresh);

            return promise;
        }

        // All good, no refresh needed
        return credentials;
    }
}

export default new ConnectionService();
