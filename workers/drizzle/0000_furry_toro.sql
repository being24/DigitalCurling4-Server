CREATE TABLE `basic_authentication` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text,
	`hash_password` text,
	`match_team_name` text,
	`match_id` text,
	`created_at` integer NOT NULL,
	`expired_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `match_data` (
	`match_id` text PRIMARY KEY NOT NULL,
	`first_team_name` text,
	`second_team_name` text,
	`first_team_id` text,
	`first_team_player1_id` text,
	`first_team_player2_id` text,
	`first_team_player3_id` text,
	`first_team_player4_id` text,
	`second_team_id` text,
	`second_team_player1_id` text,
	`second_team_player2_id` text,
	`second_team_player3_id` text,
	`second_team_player4_id` text,
	`winner_team_id` text,
	`score_id` text,
	`time_limit` real,
	`extra_end_time_limit` real,
	`standard_end_count` integer,
	`applied_rule` integer,
	`physical_simulator_id` text,
	`tournament_id` text,
	`match_name` text,
	`game_mode` text DEFAULT 'standard' NOT NULL,
	`created_at` integer,
	`started_at` integer,
	FOREIGN KEY (`score_id`) REFERENCES `score`(`score_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`physical_simulator_id`) REFERENCES `physical_simulator`(`physical_simulator_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournament`(`tournament_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `match_mixed_doubles_settings` (
	`match_id` text PRIMARY KEY NOT NULL,
	`positioned_stones_pattern` integer NOT NULL,
	`team0_power_play_end` integer,
	`team1_power_play_end` integer,
	`end_setup_team_ids` text NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `match_data`(`match_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `physical_simulator` (
	`physical_simulator_id` text PRIMARY KEY NOT NULL,
	`simulator_name` text
);
--> statement-breakpoint
CREATE TABLE `player` (
	`player_id` text PRIMARY KEY NOT NULL,
	`team_id` text,
	`max_velocity` real,
	`shot_std_dev` real,
	`angle_std_dev` real,
	`player_name` text
);
--> statement-breakpoint
CREATE TABLE `score` (
	`score_id` text PRIMARY KEY NOT NULL,
	`team0` text,
	`team1` text
);
--> statement-breakpoint
CREATE TABLE `shot_info` (
	`shot_id` text PRIMARY KEY NOT NULL,
	`player_id` text,
	`team_id` text,
	`trajectory_id` text,
	`pre_shot_state_id` text,
	`post_shot_state_id` text,
	`actual_translational_velocity` real,
	`actual_shot_angle` real,
	`actual_angular_velocity` real,
	`translational_velocity` real,
	`angular_velocity` real,
	`shot_angle` real
);
--> statement-breakpoint
CREATE TABLE `state` (
	`state_id` text PRIMARY KEY NOT NULL,
	`winner_team_id` text,
	`match_id` text,
	`end_number` integer,
	`team_shot_number` integer,
	`total_shot_number` integer,
	`first_team_remaining_time` real,
	`second_team_remaining_time` real,
	`first_team_extra_end_remaining_time` real,
	`second_team_extra_end_remaining_time` real,
	`stone_coordinate_id` text,
	`score_id` text,
	`shot_id` text,
	`next_shot_team_id` text,
	`created_at` integer,
	FOREIGN KEY (`match_id`) REFERENCES `match_data`(`match_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stone_coordinate_id`) REFERENCES `stone_coordinate`(`stone_coordinate_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`score_id`) REFERENCES `score`(`score_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stone_coordinate` (
	`stone_coordinate_id` text PRIMARY KEY NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE TABLE `tournament` (
	`tournament_id` text PRIMARY KEY NOT NULL,
	`tournament_name` text
);
--> statement-breakpoint
CREATE TABLE `trajectory` (
	`trajectory_id` text PRIMARY KEY NOT NULL,
	`trajectory_data` text,
	`data_format_version` text
);
--> statement-breakpoint
CREATE TABLE `users` (
	`username` text PRIMARY KEY NOT NULL,
	`hash_password` text,
	`salt` text
);
