package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.ConvertMediaRequest;
import com.rmyndharis.openwa.model.ConvertedMedia;
import com.rmyndharis.openwa.model.MediaConversionAvailability;

/** Media resource — server-side conversion into the formats WhatsApp plays. */
public final class MediaResource {
    private final OpenWAClient client;

    public MediaResource(OpenWAClient client) {
        this.client = client;
    }

    /**
     * Whether conversion is switched on for this deployment AND the ffmpeg binary can be run. Worth
     * checking once: against a server without it a caller must convert on its own side rather than
     * take an error per request.
     */
    public MediaConversionAvailability conversionStatus(String sessionId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/media/convert",
            null,
            null,
            MediaConversionAvailability.class);
    }

    /**
     * Convert audio into a WhatsApp voice note (Ogg/Opus, mono, tuned for speech). WhatsApp shows a
     * playable mic bubble only for this format — MP3 bytes sent with ptt produce a voice note that
     * will not play. Pass the returned base64 to sendAudio with ptt set. Requires an OPERATOR key.
     */
    public ConvertedMedia convertVoice(String sessionId, ConvertMediaRequest media) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/media/convert/voice",
            null,
            media,
            ConvertedMedia.class);
    }

    /**
     * Convert video into an MP4 every WhatsApp client accepts: baseline H.264 with AAC audio, long
     * edge bounded at 1280, index moved to the front for immediate playback. Requires an OPERATOR key.
     */
    public ConvertedMedia convertVideo(String sessionId, ConvertMediaRequest media) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/media/convert/video",
            null,
            media,
            ConvertedMedia.class);
    }
}
