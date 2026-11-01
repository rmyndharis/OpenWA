import { describeAudio, describeVideo } from './baileys-audio-probe';
import { runFfmpeg } from '../../modules/media/ffmpeg';

jest.mock('../../modules/media/ffmpeg', () => ({ runFfmpeg: jest.fn() }));
const ffmpeg = runFfmpeg as jest.Mock;

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const never = (): Promise<Buffer> => new Promise<Buffer>(() => undefined);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/**
 * The thumbnail of an outgoing video runs ffmpeg in a child process, so how many run at once and where they queue
 * decide how long a send waits. These cases live in their own file because the limiters are module state.
 */
describe('describeVideo limits', () => {
  beforeEach(() => ffmpeg.mockReset());

  it('runs through the configured FFMPEG_PATH', async () => {
    const before = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = '/opt/tools/ffmpeg';
    ffmpeg.mockResolvedValue(jpeg);
    try {
      await describeVideo(Buffer.from('video'));
    } finally {
      if (before === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = before;
    }

    expect(ffmpeg).toHaveBeenCalledWith(
      expect.anything(),
      'bin',
      'jpg',
      expect.anything(),
      expect.objectContaining({ ffmpegPath: '/opt/tools/ffmpeg' }),
    );
  });

  it('starts at most two thumbnails at once', async () => {
    const release: Array<() => void> = [];
    ffmpeg.mockImplementation(() => new Promise<Buffer>(resolve => release.push(() => resolve(jpeg))));

    const all = [1, 2, 3].map(() => describeVideo(Buffer.from('video')));
    await flush();
    expect(ffmpeg).toHaveBeenCalledTimes(2);

    release[0]();
    await flush();
    expect(ffmpeg).toHaveBeenCalledTimes(3);

    release[1]();
    release[2]();
    await Promise.all(all);
  });

  it('does not wait behind voice note reads that hold the audio slots', async () => {
    // Two voice notes whose waveform read never answers hold both audio slots.
    ffmpeg.mockImplementationOnce(never).mockImplementationOnce(never);
    void describeAudio(Buffer.from('note one'), true);
    void describeAudio(Buffer.from('note two'), true);
    await flush();
    expect(ffmpeg).toHaveBeenCalledTimes(2);

    ffmpeg.mockResolvedValueOnce(jpeg);
    await expect(describeVideo(Buffer.from('video'))).resolves.toEqual({ jpegThumbnail: jpeg.toString('base64') });
  });
});
