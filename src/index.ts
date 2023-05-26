import dotenv from "dotenv";
dotenv.config();

import PlexAPI from "./plex";
import OverseerrAPI from "./overseerr";
import TautulliAPI, { TautulliHistoryDetails } from "./tautulli";
import RadarrAPI from "./radarr";
import SonarrAPI from "./sonarr";
import _ from "lodash";
import moment from "moment";

const TAG_STALE_REQUEST = "stale_request";
const TAG_REQUESTER_WATCHED = "requester_watched";
const TAG_OTHERS_WATCHING = "others_watching";
const TAG_PREFIX_REQUESTER = "requester:";
const TAG_PREFIX_OWNER = "owner:";
const COLL_SORT_PREFIX = "zzz_";
const COLL_DEFAULT_SORT = encodeURIComponent("addedAt:desc");
const COLL_TITLE_PREFIX_MOVIE = "Movies Requested by ";
const COLL_TITLE_PREFIX_SHOW = "TV Shows Requested by ";
const STALE_ADDED_DATE_THRESHOLD = moment().subtract(6, "months");
const STALE_VIEW_DATE_THRESHOLD = moment().subtract(3, "months");
const MS_24_HOURS = 86400000;

const app = async function () {
	// Get all the requests from Overseerr.
	const requests = await OverseerrAPI.getAllRequests("all");

	// Get the Plex library sections. It's not easy to get the section ID for a given media item,
	// so it's easier to start with the sections and work down.
	const plexSections = await PlexAPI.getSections();

	// Is the optional list of library sections to include set in .env?
	const includeSections: Array<string> = process.env.PLEX_INCLUDE_SECTIONS
		? process.env.PLEX_INCLUDE_SECTIONS.split(",")
		: undefined;

	// Only do included sections if include list is set in .env
	_.remove(plexSections, (value) => {
		return (
			includeSections && includeSections.indexOf(<string>value.key) === -1
		);
	});

	for (let i = 0; i < plexSections.length; i++) {
		// ID of current library section.
		const sectionId = parseInt(<string>plexSections[i]?.key);

		console.log("-----------------------------------------------");
		console.log(`Starting Section: ${plexSections[i]?.title}`);
		console.log("-----------------------------------------------");

		// Media type of current section (e.g. TV vs Movie)
		const sectionType = <string>plexSections[i]?.type;

		// We only support Movies and TV Shows for now.
		if (sectionType !== "movie" && sectionType !== "show") {
			console.log("Unsupported Media Type: " + sectionType);
			continue;
		}

		// Get all the media items and existing collections for this library section.
		const mediaItems = await PlexAPI.getAllItems(sectionId);
		let collections = await PlexAPI.getCollections(sectionId);

		// Reset cached Plex labels since we're starting a new section.
		await PlexAPI.getLabels(sectionId);

		// Cycle through each media item in the library section, tag it with the requester.
		for (let j = 0; j < mediaItems.length; j++) {
			const start = Date.now();

			const mediaItem = mediaItems[j];

			// Does a requester entry exist for this media item?
			const request = _.find(
				requests,
				(item) => item?.media?.ratingKey === mediaItem?.ratingKey
			);

			// No request object found for this media item, jump to next loop pass.
			if (!request) {
				continue;
			}

			// Init some values we're going to need.
			const mediaId = parseInt(<string>mediaItem.ratingKey);
			const plexUsername = request?.requestedBy?.plexUsername;
			const displayName = request?.requestedBy?.displayName;

			// Print to console.
			console.log(`${mediaItem.title} requested by ${plexUsername}`);

			// Tag the media item.
			const requesterTagValue = TAG_PREFIX_REQUESTER + plexUsername;
			await PlexAPI.addLabelToItem(
				sectionId,
				PlexAPI.getPlexTypeCode(sectionType),
				mediaId,
				requesterTagValue
			);

			// Feature flag to turn off the creation of smart collections.
			if (process.env.FEATURE_CREATE_COLLECTIONS !== "0") {
				// This is what the smart collection should be called.
				let collectionTitle;
				if (displayName) {
					collectionTitle =
						sectionType == "movie"
							? COLL_TITLE_PREFIX_MOVIE + displayName
							: COLL_TITLE_PREFIX_SHOW + displayName;
				} else {
					collectionTitle =
						sectionType == "movie"
							? COLL_TITLE_PREFIX_MOVIE + plexUsername
							: COLL_TITLE_PREFIX_SHOW + plexUsername;
				}

				// Does the smart collection already exist?
				const collection = _.find(
					collections,
					(item) => item?.title === collectionTitle
				);

				// If collection exists with this title, assume it's set up correctly and we don't need to do anything else.
				// If collection does not exist with this title, create it and tag is with owner label.
				if (!collection) {
					// Get the numeric ID of the label we're using right now.
					const mediaLabelKey = await PlexAPI.getKeyForLabel(
						sectionId,
						requesterTagValue
					);

					// Create the new smart collection
					const createCollResult =
						await PlexAPI.createSmartCollection({
							sectionId: sectionId,
							title: collectionTitle,
							titleSort: COLL_SORT_PREFIX + collectionTitle, // TO DO Move prefix to env option.
							itemType: PlexAPI.getPlexTypeCode(sectionType),
							sort: COLL_DEFAULT_SORT, //date added descending
							query: "label=" + mediaLabelKey
						});

					// Only continue if creating the collection seems to have worked.
					if (createCollResult) {
						await PlexAPI.addLabelToItem(
							sectionId,
							PlexAPI.getPlexTypeCode(
								<string>createCollResult.type
							),
							parseInt(<string>createCollResult.ratingKey),
							TAG_PREFIX_OWNER + plexUsername
						);
					}

					// Update list of collections we're working with now that we've added one.
					collections = await PlexAPI.getCollections(sectionId);

					// Print to console.
					console.log(" -> Smart Collection created");
				}
			}

			// Now let's start looking at watch history and Radarr/Sonarr.
			// Only continue if we have the right credentials.

			// Handle Radarr items.
			if (
				sectionType == "movie" &&
				process.env.TAUTULLI_URL &&
				process.env.TAUTULLI_API_KEY &&
				process.env.RADARR_URL &&
				process.env.RADARR_API_KEY
			) {
				// Get the Radarr item using the TMDB ID, so we can get the proper Radarr ID needed for updates.
				let radarrItem = await RadarrAPI.getMediaItemForTMDBId(
					request?.media?.tmdbId
				);

				// Does the item exist in Radarr? If not, jump to next loop pass.
				if (!radarrItem) {
					continue;
				}

				// Tag the item with the requester username.
				radarrItem = await RadarrAPI.addTagToMediaItem(
					radarrItem.id,
					requesterTagValue,
					radarrItem
				);

				// Get all the history sessions for this media item.
				const histories = await TautulliAPI.getAllHistory({
					section_id: sectionId,
					rating_key: mediaId,
					order_column: "date",
					order_dir: "desc"
				});

				// Filter history sessions to look at everyone expect the requester.
				const filteredHistories_others = _.filter(
					histories,
					(session: TautulliHistoryDetails) =>
						session?.user !== plexUsername
				);
				// When was the last time someone other than the requester watched this?
				const lastWatchedDate_others =
					filteredHistories_others && filteredHistories_others.length
						? filteredHistories_others[0].date * 1000 // Convert from seconds to milliseconds
						: 0;

				// Have people other then the requester watched the item within the stale viewing threshold?
				if (
					moment(lastWatchedDate_others) > STALE_VIEW_DATE_THRESHOLD
				) {
					radarrItem = await RadarrAPI.addTagToMediaItem(
						radarrItem.id,
						TAG_OTHERS_WATCHING,
						radarrItem
					);
					radarrItem = await RadarrAPI.removeTagFromMediaItem(
						radarrItem.id,
						TAG_STALE_REQUEST,
						radarrItem
					);

					// Print to console.
					console.log(" -> Non-requester(s) watching");
				}
				// Otherwise remove the tag in case it was added in a previous session.
				else {
					radarrItem = await RadarrAPI.removeTagFromMediaItem(
						radarrItem.id,
						TAG_OTHERS_WATCHING,
						radarrItem
					);
				}

				// Filter history sessions to look at just requester user.
				const filteredHistories_requester = _.filter(
					histories,
					(session: TautulliHistoryDetails) =>
						session?.user === plexUsername
				);
				// Check if requester has fully watched it.
				const watchedSession = _.find(
					filteredHistories_requester,
					(session: TautulliHistoryDetails) =>
						session?.watched_status === 1
				);

				// We have evidence that the requester has fully watched the media item.
				if (watchedSession) {
					// Add the tag to the media item in Radarr indicating that the requester has watched the item.
					radarrItem = await RadarrAPI.addTagToMediaItem(
						radarrItem.id,
						TAG_REQUESTER_WATCHED,
						radarrItem
					);

					// Print to console.
					console.log(" -> Watched by requester");
				}
				// If they haven't finished watching it, is it a stale request?
				else {
					// Remove Watched tag in case it was added in a previous session erroneously (Maybe needed more for TV shows, but what the heck).
					radarrItem = await RadarrAPI.removeTagFromMediaItem(
						radarrItem.id,
						TAG_REQUESTER_WATCHED,
						radarrItem
					);
					// Remove the existing Stale tag in case they started watching it since last session.
					radarrItem = await RadarrAPI.removeTagFromMediaItem(
						radarrItem.id,
						TAG_STALE_REQUEST,
						radarrItem
					);
					// When was the last time the requester watched this?
					const lastWatchedDate_requester =
						filteredHistories_requester &&
						filteredHistories_requester.length
							? filteredHistories_requester[0].date * 1000 // Convert from seconds to milliseconds
							: 0;

					// If the media item was downloaded more than 6 months ago, and the requester (OR ANYONE ELSE) hasn't watched in the last 3 months, tag it as stale.
					if (
						moment(request.media?.mediaAddedAt) <
							STALE_ADDED_DATE_THRESHOLD &&
						moment(lastWatchedDate_requester) <
							STALE_VIEW_DATE_THRESHOLD &&
						moment(lastWatchedDate_others) <
							STALE_VIEW_DATE_THRESHOLD
					) {
						radarrItem = await RadarrAPI.addTagToMediaItem(
							radarrItem.id,
							TAG_STALE_REQUEST,
							radarrItem
						);

						// Print to console.
						console.log(" -> Stale request");
					}
					// Otherwise remove the tag.
					else {
						radarrItem = await RadarrAPI.removeTagFromMediaItem(
							radarrItem.id,
							TAG_STALE_REQUEST,
							radarrItem
						);
					}
				}
			}
			// Handle Sonarr items.
			if (
				sectionType == "show" &&
				process.env.TAUTULLI_URL &&
				process.env.TAUTULLI_API_KEY &&
				process.env.SONARR_URL &&
				process.env.SONARR_API_KEY
			) {
				// Get the Sonarr item using the TVDB ID, so we can get the proper Sonarr ID needed for updates.
				let sonarrItem = await SonarrAPI.getMediaItemForTVDBId(
					request?.media?.tvdbId
				);

				// Does the item exist in Sonarr? If not, jump to next loop pass.
				if (!sonarrItem) {
					continue;
				}

				// Tag the item with the requester username.
				sonarrItem = await SonarrAPI.addTagToMediaItem(
					sonarrItem.id,
					requesterTagValue,
					sonarrItem
				);

				// Get all the history sessions for this media item.
				const histories = await TautulliAPI.getAllHistory({
					section_id: sectionId,
					grandparent_rating_key: mediaId,
					order_column: "date",
					order_dir: "desc"
				});

				// Filter history sessions to look at everyone expect the requester.
				const filteredHistories_others = _.filter(
					histories,
					(session: TautulliHistoryDetails) =>
						session?.user !== plexUsername
				);
				// When was the last time someone other than the requester watched this?
				const lastWatchedDate_others =
					filteredHistories_others && filteredHistories_others.length
						? _.first(filteredHistories_others).date * 1000 // Convert from seconds to milliseconds
						: 0;

				// Have people other then the requester watched the item within the stale viewing threshold?
				if (
					moment(lastWatchedDate_others) > STALE_VIEW_DATE_THRESHOLD
				) {
					sonarrItem = await SonarrAPI.addTagToMediaItem(
						sonarrItem.id,
						TAG_OTHERS_WATCHING,
						sonarrItem
					);
					sonarrItem = await SonarrAPI.removeTagFromMediaItem(
						sonarrItem.id,
						TAG_STALE_REQUEST,
						sonarrItem
					);

					// Print to console.
					console.log(" -> Non-requester(s) watching");
				}
				// Otherwise remove the tag in case it was added in a previous session.
				else {
					sonarrItem = await SonarrAPI.removeTagFromMediaItem(
						sonarrItem.id,
						TAG_OTHERS_WATCHING,
						sonarrItem
					);
				}

				// Filter history sessions to look at just requester user.
				const filteredHistories_requester = _.filter(
					histories,
					(session: TautulliHistoryDetails) =>
						session?.user === plexUsername
				);

				// Check if requester has fully watched it.
				const watchedHistories = _.filter(filteredHistories_requester, {
					watched_status: 1
				});

				// Make a list of unique episodes that have been fully watched.
				const uniqueEpisodeHistories = _.uniqBy(
					watchedHistories,
					"rating_key"
				);

				// Has the user watched all the episodes, and have all the current episodes been downloaded?
				if (
					uniqueEpisodeHistories?.length ===
						sonarrItem?.statistics?.episodeCount &&
					sonarrItem?.statistics?.percentOfEpisodes === 100
				) {
					// Tag the media item.
					sonarrItem = await SonarrAPI.addTagToMediaItem(
						sonarrItem.id,
						TAG_REQUESTER_WATCHED,
						sonarrItem
					);

					// Print to console.
					console.log(" -> Watched by requester");
				}
				// If they haven't finished watching it, is it a stale request?
				else {
					// Remove Watched tag in case it was added in a previous session (e.g. maybe they were finished before, but new episodes came out.).
					sonarrItem = await SonarrAPI.removeTagFromMediaItem(
						sonarrItem.id,
						TAG_REQUESTER_WATCHED,
						sonarrItem
					);
					// Remove the existing Stale tag in case they started watching it since last session.
					sonarrItem = await SonarrAPI.removeTagFromMediaItem(
						sonarrItem.id,
						TAG_STALE_REQUEST,
						sonarrItem
					);

					// When was the last time the requester watched this?
					const lastWatchedDate_requester =
						filteredHistories_requester &&
						filteredHistories_requester.length
							? filteredHistories_requester[0].date * 1000 // Convert from seconds to milliseconds
							: 0;

					// If the media item was downloaded more than 6 months ago, and the requester (OR ANYONE ELSE) hasn't watched in the last 3 months, tag it as stale.
					if (
						moment(request.media?.mediaAddedAt) <
							STALE_ADDED_DATE_THRESHOLD &&
						moment(lastWatchedDate_requester) <
							STALE_VIEW_DATE_THRESHOLD &&
						moment(lastWatchedDate_others) <
							STALE_VIEW_DATE_THRESHOLD
					) {
						sonarrItem = await SonarrAPI.addTagToMediaItem(
							sonarrItem.id,
							TAG_STALE_REQUEST,
							sonarrItem
						);

						// Print to console.
						console.log(" -> Stale request");
					}
					// Otherwise remove the tag.
					else {
						sonarrItem = await SonarrAPI.removeTagFromMediaItem(
							sonarrItem.id,
							TAG_STALE_REQUEST,
							sonarrItem
						);
					}
				}
			}

			const end = Date.now();
			debugPerformance(` -> Completed in: ${end - start} ms`);
		}

		console.log("Done Section.");
	}

	console.log("Done, Done, Done.");
};

const startDelay =
	process.env.START_DELAY_MS && parseInt(process.env.START_DELAY_MS) > 0
		? parseInt(process.env.START_DELAY_MS)
		: 0;

setTimeout(() => {
	if (process.env.FEATURE_RUN_ONCE !== "1") {
		// Feature flag to disable running every 24h. For development. Defaults to running every 24h.
		// Run every 24 h.
		setInterval(app, MS_24_HOURS);
	}
	app();
}, startDelay);

// For displaying execution time of each media item.
const debugPerformance = function (data: unknown) {
	if (process.env.NODE_ENV == "benchmark1") {
		console.log(data);
	}
};
