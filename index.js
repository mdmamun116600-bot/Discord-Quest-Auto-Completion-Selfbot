require('dotenv').config();
const {
    Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
    TextInputBuilder, TextInputStyle, EmbedBuilder, AttachmentBuilder,
    PermissionFlagsBits, Colors
} = require('discord.js');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// ==================================================
// DATABASE CONFIGURATION
// ==================================================
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==================================================
// DISCORD CLIENT INITIALIZATION
// ==================================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
});

// ==================================================
// MODULE C: DATABASE BACKUP SYSTEM
// ==================================================
async function backupDatabase(client, channelId, manual = false) {
    let filePath = null;
    try {
        const [users] = await pool.query('SELECT * FROM users');
        const [pending] = await pool.query('SELECT * FROM pending_whitelist');

        const backupData = {
            timestamp: new Date().toISOString(),
            tables: {
                users,
                pending_whitelist: pending
            }
        };

        const fileName = `backup_${Date.now()}.json`;
        filePath = path.join(__dirname, fileName);

        // Write raw SQL data serialized as JSON
        await fs.writeFile(filePath, JSON.stringify(backupData, null, 2));
        const attachment = new AttachmentBuilder(filePath);

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
            await channel.send({
                content: `**Database Backup [${manual ? 'Manual' : 'Automated'}]** - ${new Date().toLocaleString()}`,
                files: [attachment]
            });
        }
    } catch (error) {
        console.error('Backup System Error:', error);
    } finally {
        // Cleanup local file storage instantly post-upload
        if (filePath) {
            try {
                await fs.unlink(filePath);
            } catch (err) {
                // Ignore if file doesn't exist
            }
        }
    }
}

// ==================================================
// BOT STARTUP / SYSTEM INITIALIZATION
// ==================================================
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Self-Healing Buffer Table Initialization
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pending_whitelist (
                id INT AUTO_INCREMENT PRIMARY KEY,
                discord_id VARCHAR(50),
                character_name VARCHAR(24),
                password VARCHAR(128),
                email VARCHAR(64),
                gender INT,
                birth_day INT,
                birth_month INT,
                birth_year INT,
                date_of_birth VARCHAR(32),
                age INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('Buffer table verified.');
    } catch (err) {
        console.error('Error verifying buffer table:', err);
    }

    // Register Application Commands
    const commands = [
        new SlashCommandBuilder()
            .setName('setup-apply')
            .setDescription('Set up the whitelist application panel')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('backup-db')
            .setDescription('Manually backup the database (Admin Only)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    try {
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: commands }
        );
        console.log('Slash commands registered.');
    } catch (error) {
        console.error('Command registration error:', error);
    }

    // Initialize automated backup cron task (Every 24 Hours)
    setInterval(() => {
        if (process.env.BACKUP_CHANNEL_ID) {
            backupDatabase(client, process.env.BACKUP_CHANNEL_ID, false);
        }
    }, 24 * 60 * 60 * 1000);
});

// ==================================================
// MODULE B: AUTO-VERIFICATION SYSTEM
// ==================================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.channelId === process.env.VERIFY_CHANNEL_ID) {
        const content = message.content.trim();

        // Listen exclusively for 4-8 digit numerical submissions
        if (/^\d{4,8}$/.test(content)) {
            const code = parseInt(content, 10);
            try {
                const [rows] = await pool.query(
                    'SELECT uid, username FROM users WHERE verify = ? OR code = ? LIMIT 1',
                    [code, code]
                );

                if (rows.length > 0) {
                    const user = rows[0];
                    await pool.query(
                        'UPDATE users SET verify = 0, code = 0, discord_id = ? WHERE uid = ?',
                        [message.author.id, user.uid]
                    );

                    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
                    if (member) {
                        if (process.env.WHITELIST_ROLE_ID) {
                            await member.roles.add(process.env.WHITELIST_ROLE_ID).catch(() => null);
                        }
                        await member.setNickname(user.username).catch(() => null);
                    }

                    const embed = new EmbedBuilder()
                        .setColor(Colors.Green)
                        .setTitle('Verification Successful')
                        .setDescription(`Welcome, **${user.username}**! Your account is now fully linked.`);

                    await message.reply({ embeds: [embed] });
                } else {
                    await message.reply({ content: 'Invalid verification PIN. Please check in-game and try again.' });
                }
            } catch (err) {
                console.error('Verification Error:', err);
                await message.reply({ content: 'An error occurred during verification.' });
            }
        }
    }
});

// ==================================================
// MODULE A: WHITELIST LIFECYCLE & MANUAL BACKUPS
// ==================================================
client.on('interactionCreate', async (interaction) => {

    // 1. Manual Admin Database Backup
    if (interaction.isChatInputCommand() && interaction.commandName === 'backup-db') {
        await interaction.deferReply({ ephemeral: true });
        if (process.env.BACKUP_CHANNEL_ID) {
            await backupDatabase(client, process.env.BACKUP_CHANNEL_ID, true);
            await interaction.editReply({ content: 'Backup securely initiated and routed to the backup channel.' });
        } else {
            await interaction.editReply({ content: 'Backup channel ID not configured.' });
        }
        return;
    }

    // 2. Setup Application Channel GUI
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup-apply') {
        await interaction.deferReply({ ephemeral: true });

        const embed = new EmbedBuilder()
            .setTitle('Whitelist Application')
            .setDescription('Click the button below to start your whitelist application.')
            .setColor(Colors.Blue);

        const btn = new ButtonBuilder()
            .setCustomId('btn_apply')
            .setLabel('Apply for Whitelist') // Strict rule: No emojis whatsoever
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(btn);

        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.editReply({ content: 'Panel created successfully.' });
        return;
    }

    // 3. Open Whitelist Modal
    if (interaction.isButton() && interaction.customId === 'btn_apply') {
        const modal = new ModalBuilder()
            .setCustomId('modal_apply')
            .setTitle('Whitelist Application');

        const nameInput = new TextInputBuilder()
            .setCustomId('char_name')
            .setLabel('Character Name (First_Last)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const passInput = new TextInputBuilder()
            .setCustomId('ingame_pass')
            .setLabel('In-Game Password')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const emailInput = new TextInputBuilder()
            .setCustomId('email')
            .setLabel('Email Address')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const genderInput = new TextInputBuilder()
            .setCustomId('gender')
            .setLabel('Gender (Male/Female)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const dobInput = new TextInputBuilder()
            .setCustomId('dob')
            .setLabel('Date of Birth (DD/MM/YYYY)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(nameInput),
            new ActionRowBuilder().addComponents(passInput),
            new ActionRowBuilder().addComponents(emailInput),
            new ActionRowBuilder().addComponents(genderInput),
            new ActionRowBuilder().addComponents(dobInput)
        );

        // Required: Do NOT use deferReply before showing a modal.
        await interaction.showModal(modal);
        return;
    }

    // 4. Modal Submission Buffer Parsing & Review Posting
    if (interaction.isModalSubmit() && interaction.customId === 'modal_apply') {
        // Prevent timeout instantly
        await interaction.deferReply({ ephemeral: true });

        const charName = interaction.fields.getTextInputValue('char_name').trim();
        const rawPass = interaction.fields.getTextInputValue('ingame_pass');
        const email = interaction.fields.getTextInputValue('email').trim();
        const genderRaw = interaction.fields.getTextInputValue('gender').trim().toLowerCase();
        const dobRaw = interaction.fields.getTextInputValue('dob').trim();

        // Strictly enforce SA-MP First_Last logic
        if (!/^[A-Z][a-z]+_[A-Z][a-z]+$/.test(charName)) {
            return interaction.editReply({ content: 'Invalid name format. Must be Firstname_Lastname.' });
        }

        const gender = genderRaw.startsWith('m') ? 1 : 2;
        const dobParts = dobRaw.split('/');

        if (dobParts.length !== 3) {
            return interaction.editReply({ content: 'Invalid DOB format. Must be exact DD/MM/YYYY.' });
        }

        const birth_day = parseInt(dobParts[0], 10);
        const birth_month = parseInt(dobParts[1], 10);
        const birth_year = parseInt(dobParts[2], 10);
        const age = new Date().getFullYear() - birth_year;

        // Byte-for-byte Whirlpool SA-MP Encryption Hash
        const hashedPassword = crypto.createHash('whirlpool').update(rawPass, 'latin1').digest('hex').toUpperCase();

        try {
            // Guardrail duplicate logic
            const [existing] = await pool.query('SELECT uid FROM users WHERE username = ? OR email = ? LIMIT 1', [charName, email]);
            if (existing.length > 0) {
                return interaction.editReply({ content: 'Username or email is already highly registered.' });
            }

            const [result] = await pool.query(
                `INSERT INTO pending_whitelist
                (discord_id, character_name, password, email, gender, birth_day, birth_month, birth_year, date_of_birth, age)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [interaction.user.id, charName, hashedPassword, email, gender, birth_day, birth_month, birth_year, dobRaw, age]
            );

            const pendingId = result.insertId;

            // Transmit isolated review ticket context for Admin team
            const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setTitle('New Whitelist Application')
                    .addFields(
                        { name: 'Discord User', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                        { name: 'Character Name', value: charName, inline: true },
                        { name: 'Email', value: email, inline: true },
                        { name: 'Gender', value: gender === 1 ? 'Male' : 'Female', inline: true },
                        { name: 'Date of Birth', value: `${dobRaw} (Age: ${age})`, inline: true },
                        { name: 'Status', value: 'Pending', inline: true }
                    )
                    .setColor(Colors.Yellow);

                const btnAccept = new ButtonBuilder()
                    .setCustomId(`acc_${pendingId}`)
                    .setLabel('Accept')
                    .setStyle(ButtonStyle.Success);

                const btnReject = new ButtonBuilder()
                    .setCustomId(`rej_${pendingId}`)
                    .setLabel('Reject')
                    .setStyle(ButtonStyle.Danger);

                const row = new ActionRowBuilder().addComponents(btnAccept, btnReject);
                await logChannel.send({ embeds: [embed], components: [row] });
            }

            await interaction.editReply({ content: 'Your application has successfully entered the review buffer pipeline.' });
        } catch (error) {
            console.error('Application Submit Error:', error);
            await interaction.editReply({ content: 'A critical buffer error occurred while submitting your application.' });
        }
        return;
    }

    // 5. Accept Application Trigger
    if (interaction.isButton() && interaction.customId.startsWith('acc_')) {
        await interaction.deferReply({ ephemeral: true });
        const pendingId = interaction.customId.split('_')[1];

        try {
            const [pendingRows] = await pool.query('SELECT * FROM pending_whitelist WHERE id = ?', [pendingId]);
            if (pendingRows.length === 0) {
                return interaction.editReply({ content: 'Application nullified. It may have already been processed.' });
            }

            const pending = pendingRows[0];

            const [existing] = await pool.query('SELECT uid FROM users WHERE username = ? OR email = ? LIMIT 1', [pending.character_name, pending.email]);
            if (existing.length > 0) {
                return interaction.editReply({ content: 'User collision detected. Cannot force acceptance.' });
            }

            // Dynamically allocate missing primary keys manually
            const [[{ next_uid }]] = await pool.query('SELECT COALESCE(MAX(uid), 0) + 1 AS next_uid FROM users');

            // Generate regdate in 'YYYY-MM-DD HH:MM:SS' format using current time
            const now = new Date();
            const regdate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

            await pool.query(
                `INSERT INTO users
                (uid, username, password, email, gender, birth_day, birth_month, birth_year, date_of_birth, age, regdate, skin, cash, bank, level, locked, discord_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    next_uid, pending.character_name, pending.password, pending.email,
                    pending.gender, pending.birth_day, pending.birth_month, pending.birth_year,
                    pending.date_of_birth, pending.age, regdate, 299, 20000, 500, 1, 1, pending.discord_id
                ]
            );

            // Deallocate from pending buffer
            await pool.query('DELETE FROM pending_whitelist WHERE id = ?', [pendingId]);

            // Execute Guild Logic gracefully
            const guild = interaction.guild;
            const member = await guild.members.fetch(pending.discord_id).catch(() => null);
            if (member) {
                if (process.env.WHITELIST_ROLE_ID) await member.roles.add(process.env.WHITELIST_ROLE_ID).catch(() => null);
                await member.setNickname(pending.character_name).catch(() => null);
                await member.send(`Congratulations! Your whitelist application for **${pending.character_name}** was firmly accepted.`).catch(() => null);
            }

            const responseChannel = await client.channels.fetch(process.env.RESPONSE_CHANNEL_ID).catch(() => null);
            if (responseChannel) await responseChannel.send(`<@${pending.discord_id}>, your character **${pending.character_name}** has been formally accepted!`);

            // Edit Application Card Live
            const msg = interaction.message;
            const embed = EmbedBuilder.from(msg.embeds[0])
                .setColor(Colors.Green)
                .spliceFields(5, 1, { name: 'Status', value: `Accepted by ${interaction.user.tag}`, inline: true });

            await msg.edit({ embeds: [embed], components: [] });
            await interaction.editReply({ content: 'Application heavily validated and user created.' });
        } catch (error) {
            console.error('Accept Application Error:', error);
            await interaction.editReply({ content: 'A backend exception occurred validating acceptance.' });
        }
        return;
    }

    // 6. Reject Application Trigger (Requires Sub-Modal)
    if (interaction.isButton() && interaction.customId.startsWith('rej_')) {
        const pendingId = interaction.customId.split('_')[1];

        // Strict mapping: Transmits required state coordinates without triggering 'undefined property crashes'
        const modal = new ModalBuilder()
            .setCustomId(`modal_rej_${pendingId}_${interaction.channelId}_${interaction.message.id}`)
            .setTitle('Reject Application');

        const reasonInput = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason for Rejection')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

        await interaction.showModal(modal);
        return;
    }

    // 7. Modal Rejection Submission Parser
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_rej_')) {
        await interaction.deferReply({ ephemeral: true });

        const parts = interaction.customId.split('_');
        const pendingId = parts[2];
        const channelId = parts[3];
        const msgId = parts[4];

        const reason = interaction.fields.getTextInputValue('reason');

        try {
            const [pendingRows] = await pool.query('SELECT * FROM pending_whitelist WHERE id = ?', [pendingId]);

            if (pendingRows.length > 0) {
                const pending = pendingRows[0];
                await pool.query('DELETE FROM pending_whitelist WHERE id = ?', [pendingId]);

                const guild = interaction.guild;
                const member = await guild.members.fetch(pending.discord_id).catch(() => null);
                if (member) await member.send(`Your whitelist application for **${pending.character_name}** was rejected.\nReason: ${reason}`).catch(() => null);

                const responseChannel = await client.channels.fetch(process.env.RESPONSE_CHANNEL_ID).catch(() => null);
                if (responseChannel) await responseChannel.send(`<@${pending.discord_id}>, your application was rejected.\nReason: ${reason}`);
            }

            // Safe fetch logic to update review embed using cached positional coordinates
            const logChannel = await client.channels.fetch(channelId).catch(() => null);
            if (logChannel) {
                const msg = await logChannel.messages.fetch(msgId).catch(() => null);
                if (msg) {
                    const embed = EmbedBuilder.from(msg.embeds[0])
                        .setColor(Colors.Red)
                        .spliceFields(5, 1, { name: 'Status', value: `Rejected by ${interaction.user.tag}\nReason: ${reason}`, inline: true });

                    await msg.edit({ embeds: [embed], components: [] });
                }
            }

            await interaction.editReply({ content: 'Application strictly rejected and deallocated.' });
        } catch (error) {
            console.error('Reject Application Error:', error);
            await interaction.editReply({ content: 'An error occurred cascading the rejection.' });
        }
        return;
    }
});

client.login(process.env.BOT_TOKEN);
