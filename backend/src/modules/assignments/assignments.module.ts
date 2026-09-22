import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Assignment } from '../../common/entities/assignment.entity';
import { AssignmentSubmission } from '../../common/entities/assignment-submission.entity';
import { CourseEnrollment } from '../../common/entities/course-enrollment.entity';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';

@Module({
  imports: [TypeOrmModule.forFeature([Assignment, AssignmentSubmission, CourseEnrollment])],
  controllers: [AssignmentsController],
  providers: [AssignmentsService],
})
export class AssignmentsModule {}
