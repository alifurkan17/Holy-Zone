const Discord = require('discord.js');
const playdl = require('play-dl');
const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const {
    REST,
    Routes,
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    PermissionFlagsBits,
} = require('discord.js');

const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection } = require('@discordjs/voice');

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

const retryAttempts = 3;
let currentConnection;
let playlist = [];

function getVideoIdFromUrl(url) {
    let videoId;
    if (url.includes('youtu.be/')) {
        videoId = url.split('youtu.be/')[1].split('?')[0];
    } else if (url.includes('youtube.com/watch')) {
        videoId = url.split('v=')[1].split('&')[0];
    } else if (url.includes('youtube.com/')) {
        videoId = url.split('youtube.com/')[1].split('?')[0];
    }
    return videoId;
}

async function getVideoTitleFromYouTubeAPI(url) {
    try {
        const videoId = getVideoIdFromUrl(url);
        console.log('Video ID:', videoId); // Debug için eklendi
        if (!videoId) {
            console.error('Geçersiz YouTube URL\'si:', url);
            return 'Unknown';
        }

        const response = await axios.get(`https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${process.env.YOUTUBE_API_KEY}&part=snippet`);
        if (response.data.items.length > 0) {
            const title = response.data.items[0].snippet.title;
            return title;
        } else {
            console.error('YouTube API yanıtı beklenen veriye sahip değil:', response.data);
            return 'Unknown';
        }
    } catch (error) {
        console.error('Video başlığını alma sırasında bir hata oluştu:', error);
        return 'Unknown';
    }
}

async function playSong(song, connection, interaction, attempt = 1) {
    try {
        console.log('Çalınacak şarkı:', song);

        if (interaction && interaction.replied === undefined) {
            return;
        }

        if (song.title === 'Unknown') {
            song.title = await getVideoTitleFromYouTubeAPI(song.url);
        }

        const stream = await playdl.stream(song.url);
        const player = createAudioPlayer();
        const resource = createAudioResource(stream.stream, { inputType: stream.type });

        player.on('error', async (error) => {
            console.error('Şarkı akışı sırasında hata oluştu:', error.message);
            console.error('Hatanın nedeni:', error.code);
            console.error('Hata detayları:', error);

            if (error.message && error.message.includes('aborted')) {
                console.error('Akış aborted hatası aldı, tekrar denenecek.');
                if (attempt < retryAttempts) {
                    console.log(`Tekrar deneme: ${attempt}/${retryAttempts}`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    await playSong(song, connection, interaction, attempt + 1);
                } else {
                    console.error('Şarkı çalınamadı! Tekrar deneme hakkı tükendi.');
                    await interaction.reply('Şarkı çalınırken bir hata oluştu! Lütfen daha sonra tekrar deneyin.');
                }
            } else {
                await interaction.reply('Şarkı çalınırken bir hata oluştu! Lütfen daha sonra tekrar deneyin.');
            }
        });

        const { AudioPlayerStatus } = require('@discordjs/voice');

        player.on(AudioPlayerStatus.Idle, () => {
            console.log('Şarkı bitti!');
            if (playlist.length > 0) {
                const removedSong = playlist.shift();
                console.log(`Çalma listesinden kaldırılan şarkı: ${removedSong.title}`);
                
                if (playlist.length > 0) {
                    const nextSong = playlist[0];
                    playSong(nextSong, connection, interaction);
                    if (interaction) {
                        interaction.channel.send('Sıradaki şarkıya geçiliyor...');
                    }
                } else {
                    console.log('Çalma listesi boş, bağlantıyı kesiyorum.');
                    currentConnection.destroy();
                    currentConnection = null;
                    if (interaction) {
                        interaction.channel.send('Çalma listesi boş, bağlantıyı kesiyorum.');
                    }
                }
            }
        });

        connection.subscribe(player);
        player.play(resource);

        if (interaction && !interaction.replied) {
            try {
                await interaction.reply(`Çalan şarkı: ${song.title}`);
            } catch (error) {
                console.error('Etkileşim zaten yanıtlandı:', error);
            }
        }
    } catch (error) {
        console.error('Şarkı çalınırken bir hata oluştu:', error);
        if (!interaction.replied) {
            await interaction.reply('Şarkı çalınırken bir hata oluştu! Lütfen daha sonra tekrar deneyin.');
        }
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences,
    ],
});

(async () => {
    try {
        await client.on('ready', async () => {
            console.log('Bot hazır!');
            console.log('Komutlar kaydediliyor...');
            try {
                await rest.put(Routes.applicationCommands(client.user.id), { body: [
                    new SlashCommandBuilder()
                        .setName('çal')
                        .setDescription('Bir YouTube video URL\'sini veya şarkının adını girerek şarkıyı çalar.')
                        .addStringOption(
                            option =>
                                option
                                    .setName('şarkı')
                                    .setDescription('YouTube video URL\'si veya şarkı adı')
                                    .setRequired(true)
                        ),
                    new SlashCommandBuilder()
                        .setName('atla')
                        .setDescription('Çalan şarkıyı atlar.'),
                    new SlashCommandBuilder()
                        .setName('dur')
                        .setDescription('Çalan şarkıyı durdurur.'),
                    new SlashCommandBuilder()
                        .setName('devam')
                        .setDescription('Duraklatılmış şarkıyı devam ettirir.'),
                    new SlashCommandBuilder()
                        .setName('ayrıl')
                        .setDescription('Ses kanalından ayrılır.'),
                    new SlashCommandBuilder()
                        .setName('temizle')
                        .setDescription('Çalma listesini temizler.'),
                    new SlashCommandBuilder()
                        .setName('liste')
                        .setDescription('Çalma listesini görüntüler.')
                ] });
                console.log('Komutlar başarıyla kaydedildi!');
            } catch (error) {
                console.error('Komutların kaydedilmesi sırasında bir hata oluştu!', error);
            }
        });

        client.on('interactionCreate', async (interaction) => {
            if (!interaction.isCommand()) return;
        
            const command = interaction.commandName;
        
            if (command === 'çal') {
                try {
                    const songName = interaction.options.getString('şarkı');
                
                    if (!interaction.member.voice.channel) {
                        return await interaction.reply('Herhangi bir ses kanalında değilsiniz!');
                    }
                
                    if (!interaction.member.voice.channel.permissionsFor(client.user).has(PermissionFlagsBits.Connect | PermissionFlagsBits.Speak)) {
                        return await interaction.reply('Ses kanalına bağlanmak veya konuşmak için iznim yok!');
                    }
                
                    const connection = await joinVoiceChannel({
                        channelId: interaction.member.voice.channel.id,
                        guildId: interaction.guild.id,
                        adapterCreator: interaction.guild.voiceAdapterCreator,
                    });
                
                    if (!connection) return;
                
                    currentConnection = connection;
                
                    let url;
                    let songTitle;
                    if (songName.startsWith('http')) {
                        url = songName;
                        songTitle = await getVideoTitleFromYouTubeAPI(url);
                    } else {
                        const searchResult = await playdl.search(songName, { limit: 1 });
                        if (searchResult && searchResult[0]) {
                            url = searchResult[0].url;
                            songTitle = searchResult[0].title;
                        } else {
                            return await interaction.reply('Belirtilen şarkı adıyla ilgili sonuç bulunamadı.');
                        }
                    }
                
                    const isSongInPlaylist = playlist.some(item => item.url === url);
                    if (!isSongInPlaylist) {
                        playlist.push({ url, title: songTitle });
                
                        if (playlist.length === 1) {
                            playSong({ url, title: songTitle }, connection, interaction);
                        } else {
                            await interaction.reply(`Şarkı çalma listesine eklendi: ${songTitle}`);
                        }
                    } else {
                        await interaction.reply('Bu şarkı zaten çalma listesinde!');
                    }
                } catch (error) {
                    console.error('Komut yürütülürken hata:', error);
                    if (!interaction.replied) {
                        await interaction.reply('Bir hata oluştu! Lütfen komutu tekrar deneyin.');
                    }
                }
            } else if (command === 'atla') {
                if (!currentConnection) return await interaction.reply('Şu anda hiçbir şarkı çalmıyor.');
                if (playlist.length === 0) return await interaction.reply('Çalma listesinde atlanacak bir şarkı yok.');
                
                playlist.shift(); // Listenin başındaki şarkıyı atla
                if (playlist.length > 0) {
                    const nextSong = playlist[0];
                    playSong(nextSong, currentConnection, interaction);
                } else {
                    currentConnection.destroy();
                    currentConnection = null;
                }
                await interaction.reply('Şarkı başarıyla atlandı.');
            } else if (command === 'dur') {
                if (!currentConnection) return await interaction.reply('Şu anda hiçbir şarkı çalmıyor.');
                const player = getVoiceConnection(interaction.guildId).state.subscription.player;
                player.pause();
                await interaction.reply('Çalan şarkı duraklatıldı.');
            } else if (command === 'devam') {
                if (!currentConnection) return await interaction.reply('Şu anda hiçbir şarkı çalmıyor.');
                const player = getVoiceConnection(interaction.guildId).state.subscription.player;
                player.unpause();
                await interaction.reply('Çalan şarkı devam ettiriliyor.');
            } else if (command === 'ayrıl') {
                if (!currentConnection) return await interaction.reply('Şu anda herhangi bir ses kanalında değilim.');
                currentConnection.disconnect();
                currentConnection = null;
                playlist = []; // Çalma listesini temizle
                await interaction.reply('Ses kanalından ayrıldım ve çalma listesi temizledim.');
            } else if (command === 'temizle') {
                playlist = [];
                await interaction.reply('Çalma listesi temizlendi.');
            } else if (command === 'liste') {
                const songList = playlist.map((song, index) => `${index + 1}. ${song.title}`).join('\n');
                await interaction.reply(`Çalma Listesi:\n${songList}`);
            }
        });

        await client.login(process.env.TOKEN);
    } catch (error) {
        console.error('Botun başlatılması sırasında bir hata oluştu:', error);
    }
})();
