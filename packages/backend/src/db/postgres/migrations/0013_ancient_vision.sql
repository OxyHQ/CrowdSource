-- oxy:deploy-phase=post
CREATE INDEX "sortition_draws_status_drawn_at_idx" ON "sortition_draws" USING btree ("status","drawn_at");
