import { loadLocalNangoConfig, nangoConfigFile } from '../nango-config.service.js';
import type { NangoConnection } from '../../models/Connection.js';
import { SyncResult, SyncType, SyncStatus, Job as SyncJob } from '../../models/Sync.js';
import { createActivityLogMessage, createActivityLogMessageAndEnd, updateSuccess as updateSuccessActivityLog } from '../activity.service.js';
import { addSyncConfigToJob, updateSyncJobResult, updateSyncJobStatus } from '../sync/job.service.js';
import { getSyncConfig } from './config.service.js';
import { checkForIntegrationFile } from '../nango-config.service.js';
import { getLastSyncDate } from './sync.service.js';
import { formatDataRecords } from './data-records.service.js';
import { upsert } from './data.service.js';
import accountService from '../account.service.js';
import integationService from './integration.service.js';
import webhookService from '../webhook.service.js';
import { NangoSync } from '../../sdk/sync.js';
import { isCloud, getApiUrl } from '../../utils/utils.js';
import errorManager from '../../utils/error.manager.js';
import type { NangoIntegrationData, NangoConfig, NangoIntegration } from '../../integrations/index.js';
import type { UpsertResponse, UpsertSummary } from '../../models/Data.js';
import type { Account } from '../../models/Admin';

interface SyncRunConfig {
    writeToDb: boolean;
    nangoConnection: NangoConnection;
    syncName: string;
    syncType: SyncType;

    syncId?: string;
    syncJobId?: number;
    activityLogId?: number;

    loadLocation?: string;
    debug?: boolean;
}

export default class SyncRun {
    writeToDb: boolean;
    nangoConnection: NangoConnection;
    syncName: string;
    syncType: SyncType;

    syncId?: string;
    syncJobId?: number;
    activityLogId?: number;
    loadLocation?: string;
    debug?: boolean;

    constructor(config: SyncRunConfig) {
        this.writeToDb = config.writeToDb;
        this.nangoConnection = config.nangoConnection;
        this.syncName = config.syncName;
        this.syncType = config.syncType;

        if (config.syncId) {
            this.syncId = config.syncId;
        }

        if (config.syncJobId) {
            this.syncJobId = config.syncJobId;
        }

        if (config.activityLogId) {
            this.activityLogId = config.activityLogId;
        }

        if (config.loadLocation) {
            this.loadLocation = config.loadLocation;
        }

        if (config.debug) {
            this.debug = config.debug;
        }
    }

    async run(optionalLastSyncDate?: Date | null, bypassAccount?: boolean, optionalSecretKey?: string, optionalHost?: string): Promise<boolean | object> {
        if (this.debug) {
            const content = this.loadLocation ? `Looking for a local nango config at ${this.loadLocation}` : `Looking for a sync config for ${this.syncName}`;
            if (this.writeToDb) {
                await createActivityLogMessage({
                    level: 'debug',
                    activity_log_id: this.activityLogId as number,
                    timestamp: Date.now(),
                    content
                });
            } else {
                console.log(content);
            }
        }
        const nangoConfig = this.loadLocation ? await loadLocalNangoConfig(this.loadLocation) : await getSyncConfig(this.nangoConnection, this.syncName);

        if (!nangoConfig) {
            const message = `No sync configuration was found for ${this.syncName}.`;
            if (this.activityLogId) {
                await this.reportFailureForResults(message);
            } else {
                console.error(message);
            }
            return false;
        }

        const { integrations } = nangoConfig as NangoConfig;
        let result = true;

        if (!integrations[this.nangoConnection.provider_config_key] && !this.writeToDb) {
            const message = `The connection you provided which applies to integration "${this.nangoConnection.provider_config_key}" does not match any integration in the ${nangoConfigFile}`;
            console.error(message);

            return false;
        }

        // if there is a matching customer integration code for the provider config key then run it
        if (integrations[this.nangoConnection.provider_config_key]) {
            let account: Account | null = null;

            if (!bypassAccount) {
                account = await accountService.getAccountById(this.nangoConnection.account_id as number);
            }

            if (!account && !bypassAccount) {
                await this.reportFailureForResults(
                    `No account was found for ${this.nangoConnection.account_id}. The sync cannot continue without a valid account`
                );
                return false;
            }

            let secretKey;

            if (isCloud()) {
                secretKey = optionalSecretKey || (account ? (account?.secret_key as string) : '');
            } else {
                secretKey = optionalSecretKey || process.env['NANGO_SECRET_KEY'] ? (process.env['NANGO_SECRET_KEY'] as string) : '';
            }

            const nango = new NangoSync({
                host: optionalHost || getApiUrl(),
                connectionId: String(this.nangoConnection?.connection_id),
                providerConfigKey: String(this.nangoConnection?.provider_config_key),
                activityLogId: this.activityLogId as number,
                secretKey,
                nangoConnectionId: this.nangoConnection?.id as number,
                syncId: this.syncId,
                syncJobId: this.syncJobId,
                dryRun: !this.writeToDb
            });

            const providerConfigKey = this.nangoConnection.provider_config_key;
            const syncObject = integrations[providerConfigKey] as unknown as { [key: string]: NangoIntegration };

            if (!isCloud()) {
                const { path: integrationFilePath, result: integrationFileResult } = checkForIntegrationFile(this.syncName, this.loadLocation);
                if (!integrationFileResult) {
                    await this.reportFailureForResults(
                        `Integration was attempted to run for ${this.syncName} but no integration file was found at ${integrationFilePath}.`
                    );

                    return false;
                }
            }

            let lastSyncDate: Date | null | undefined = null;

            if (!this.writeToDb) {
                lastSyncDate = optionalLastSyncDate;
            } else {
                lastSyncDate = await getLastSyncDate(this.nangoConnection?.id as number, this.syncName);
            }

            if (this.debug) {
                const content = `Last sync date is ${lastSyncDate}`;
                if (this.writeToDb) {
                    await createActivityLogMessage({
                        level: 'debug',
                        activity_log_id: this.activityLogId as number,
                        timestamp: Date.now(),
                        content
                    });
                } else {
                    console.log(content);
                }
            }

            nango.setLastSyncDate(lastSyncDate as Date);
            const syncData = syncObject[this.syncName] as unknown as NangoIntegrationData;
            const { returns: models } = syncData;

            if (syncData.sync_config_id) {
                await addSyncConfigToJob(this.syncJobId as number, syncData.sync_config_id);
            }

            try {
                result = true;

                const userDefinedResults = await integationService.runScript(this.syncName, this.activityLogId as number, nango, syncData, this.loadLocation);

                if (userDefinedResults === null) {
                    await this.reportFailureForResults(
                        `The integration was run but there was a problem in retrieving the results from the script "${this.syncName}"${
                            syncData?.version ? ` version: ${syncData.version}` : ''
                        }.`
                    );

                    return false;
                }

                if (!this.writeToDb) {
                    return userDefinedResults;
                }

                let i = 0;
                for (const model of models) {
                    if (userDefinedResults[model]) {
                        if (!this.syncId) {
                            continue;
                        }

                        const formattedResults = formatDataRecords(
                            userDefinedResults[model],
                            this.nangoConnection.id as number,
                            model,
                            this.syncId,
                            this.syncJobId as number
                        );

                        if (this.writeToDb && this.activityLogId) {
                            if (formattedResults.length === 0) {
                                this.reportResults(
                                    model,
                                    { addedKeys: [], updatedKeys: [], affectedInternalIds: [], affectedExternalIds: [] },
                                    i,
                                    models.length,
                                    syncData.version
                                );
                            }

                            if (formattedResults.length > 0) {
                                const upsertResult: UpsertResponse = await upsert(
                                    formattedResults,
                                    '_nango_sync_data_records',
                                    'external_id',
                                    this.nangoConnection.id as number,
                                    model,
                                    this.activityLogId
                                );

                                if (upsertResult.success) {
                                    const { summary } = upsertResult;

                                    this.reportResults(model, summary as UpsertSummary, i, models.length, syncData.version);
                                }

                                if (!upsertResult.success) {
                                    errorManager.report(upsertResult?.error, { accountId: this.nangoConnection.account_id as number });

                                    await this.reportFailureForResults(`There was a problem upserting the data for ${this.syncName} and the model ${model}`);

                                    return false;
                                }
                            }
                        }
                    }
                    i++;
                }
            } catch (e) {
                result = false;
                const errorMessage = JSON.stringify(e, ['message', 'name', 'stack'], 2);
                await this.reportFailureForResults(
                    `The ${this.syncType} "${this.syncName}"${
                        syncData?.version ? ` version: ${syncData?.version}` : ''
                    } sync did not complete successfully and has the following error: ${errorMessage}`
                );
            }
        }

        return result;
    }

    async reportResults(model: string, responseResults: UpsertSummary, index: number, numberOfModels: number, version?: string): Promise<void> {
        if (!this.writeToDb || !this.activityLogId || !this.syncJobId) {
            return;
        }

        if (index === numberOfModels - 1) {
            await updateSyncJobStatus(this.syncJobId, SyncStatus.SUCCESS);
            await updateSuccessActivityLog(this.activityLogId, true);
        }

        const updatedResults = {
            [model]: {
                added: responseResults.addedKeys.length,
                updated: responseResults.updatedKeys.length
            }
        };

        const syncResult: SyncJob = await updateSyncJobResult(this.syncJobId, updatedResults, model);

        const { result } = syncResult;

        let added = 0;
        let updated = 0;

        if (result && result[model]) {
            const modelResult = result[model] as SyncResult;
            added = modelResult.added;
            updated = modelResult.updated;
        } else {
            // legacy json structure
            added = (result?.['added'] as unknown as number) ?? 0;
            updated = (result?.['updated'] as unknown as number) ?? 0;
        }

        const successMessage =
            `The ${this.syncType} "${this.syncName}" sync has been completed to the ${model} model.` +
            (version ? ` The version integration script version ran was ${version}.` : '');

        const resultMessage =
            added > 0 || updated > 0
                ? `The result was ${added} added record${added === 1 ? '' : 's'} and ${updated} updated record${updated === 1 ? '.' : 's.'}`
                : 'The external API returned did not return any new or updated data so nothing was inserted or updated.';

        const content = `${successMessage} ${resultMessage}`;

        await webhookService.sendUpdate(
            this.nangoConnection,
            this.syncName,
            model,
            { added, updated },
            this.syncType,
            syncResult.updated_at as string,
            this.activityLogId
        );

        if (index === numberOfModels - 1) {
            await createActivityLogMessageAndEnd({
                level: 'info',
                activity_log_id: this.activityLogId,
                timestamp: Date.now(),
                content
            });
        } else {
            await createActivityLogMessage({
                level: 'info',
                activity_log_id: this.activityLogId,
                timestamp: Date.now(),
                content
            });
        }
    }

    async reportFailureForResults(content: string) {
        if (!this.writeToDb || !this.activityLogId || !this.syncJobId) {
            console.error(content);
            return;
        }

        await updateSuccessActivityLog(this.activityLogId, false);
        await updateSyncJobStatus(this.syncJobId, SyncStatus.STOPPED);

        await createActivityLogMessageAndEnd({
            level: 'error',
            activity_log_id: this.activityLogId,
            timestamp: Date.now(),
            content
        });
    }
}
