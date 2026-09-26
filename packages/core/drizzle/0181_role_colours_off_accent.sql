-- Move the Builder and Researcher default colours off the accent orange, which is
-- reserved for action/progress. Only rows still carrying the OLD default for that
-- slug are touched; a colour anyone chose deliberately is left alone.
UPDATE "workspace_skills" SET "color" = '#0C72CB' WHERE "slug" = 'builder' AND lower("color") = '#d4724a';
--> statement-breakpoint
UPDATE "workspace_skills" SET "color" = '#B24C9C' WHERE "slug" = 'researcher' AND lower("color") = '#d97706';
